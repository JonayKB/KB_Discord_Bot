import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ChannelType, type Client } from 'discord.js';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { WebSocketServer, type WebSocket } from 'ws';
import { bus, type BusEvent } from '../core/bus';
import { env } from '../core/config';
import type { DB } from '../core/db';
import { NEWS_DIR, UPLOADS_DIR } from '../core/db';
import { getFile, isInlineImage, registerFile, safeName, toFileInfo } from '../core/files';
import { BotError, HttpError, asyncRoute, bool, strArray } from '../core/http';
import { getLogs } from '../core/logs';
import { getServices } from '../core/services';
import { createStatsIngestRouter } from '../modules/servers/ingest';
import { createLauncherRouter } from '../modules/servers/launcher';
import { INGEST_PATH } from '../modules/servers/stats';
import type { ModuleManager } from '../core/module';
import { Logger, type LogLevel } from '../utils/Logger';
import { STAFF_EVENTS, getStaffRoleIds, requireStaffRoute, resolveAccess, setStaffRoleIds, type PanelAccess } from './access';
import { createAuthRouter, purgeExpiredSessions, requireAuth, requireCsrfHeader, sessionFromRequest } from './auth';

const logger = new Logger('Panel');
const startedAt = Date.now();

export interface WebDeps {
    client: Client;
    db: DB;
    manager: ModuleManager;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'"
    );
    next();
}

export function startWebServer({ client, db, manager }: WebDeps): http.Server {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);

    // ── Público: login ──
    app.use('/auth', createAuthRouter(db, client));

    // ── Público: noticias que lee el launcher (sin sesión) ──
    app.use('/news', express.static(NEWS_DIR, {
        index: false,
        redirect: false,
        setHeaders: (res, file) => {
            res.setHeader('Cache-Control', path.basename(file) === 'latest.json' ? 'no-cache' : 'public, max-age=86400');
        },
    }), (_req, res) => void res.status(404).end());

    // ── Público: estado de los servidores y estadísticas de cada jugador para el launcher (sin sesión) ──
    app.use('/servers', createLauncherRouter(() => (manager.isRunning('servers') ? getServices() : null)));

    // ── Público: estadísticas que envía el mod de Minecraft (autenticado con su API key, sin sesión) ──
    app.use(INGEST_PATH, createStatsIngestRouter(db, () => (manager.isRunning('servers') ? getServices().mcStats : null)));

    // ── API (requiere sesión) ──
    const api = Router();
    api.use(requireAuth(db, client));
    api.use(requireCsrfHeader);
    api.use(requireStaffRoute);
    api.use(express.json({ limit: '1mb' }));

    api.get('/me', (req, res) => res.json(req.session));

    // ── Acceso al panel: roles de Discord con permisos de administrador (solo propietario) ──
    api.get('/access', (_req, res) => res.json({ roleIds: getStaffRoleIds(db) }));
    api.put('/access', (req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        const roleIds = strArray(req.body?.roleIds, 'roleIds', 50);
        if (roleIds.some(id => id === guild.id || !guild.roles.cache.has(id))) throw new HttpError(400, 'Alguno de los roles no es válido.');
        setStaffRoleIds(db, roleIds);
        logger.info(`🔑 ${req.session!.username} ha cambiado los roles de administrador del panel`);
        res.json({ roleIds: getStaffRoleIds(db) });
    });

    // Un administrador no puede sancionar a quien también tiene acceso al panel.
    api.post('/moderation/actions', asyncRoute(async (req, _res, next) => {
        if (req.session!.access === 'staff' && await resolveAccess(client, db, String(req.body?.userId))) {
            throw new HttpError(403, 'No puedes sancionar a alguien con acceso al panel.');
        }
        next();
    }));

    api.get('/status', (_req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        const since = Date.now() - 24 * 3600_000;
        const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
        res.json({
            ready: client.isReady(),
            bot: client.user ? { tag: client.user.username, avatar: client.user.displayAvatarURL({ size: 64 }) } : null,
            guild: guild ? { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount } : null,
            uptimeMs: Date.now() - startedAt,
            wsPingMs: client.ws.ping,
            modules: manager.list(),
            stats: {
                sent24h: count("SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND status='sent' AND created_at > ?", since),
                failed24h: count("SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND status='failed' AND created_at > ?", since),
                received24h: count("SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND created_at > ?", since),
                unread: count("SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND kind='dm' AND read_at IS NULL"),
                activeJobs: count('SELECT COUNT(*) AS n FROM jobs WHERE enabled = 1'),
                confirmed: count("SELECT COUNT(*) AS n FROM confirmations WHERE status='confirmed'"),
            },
        });
    });

    // ── Datos del servidor de Discord ──
    api.get('/guild/members', (req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        const q = String(req.query.q ?? '').trim().toLowerCase();
        const members = [...guild.members.cache.values()].filter(m => !m.user.bot && (
            !q || m.user.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.id === q
        ));
        members.sort((a, b) => a.displayName.localeCompare(b.displayName));
        res.json(members.slice(0, 25).map(m => ({
            id: m.id,
            username: m.user.username,
            displayName: m.displayName,
            avatar: m.user.displayAvatarURL({ size: 64 }),
        })));
    });

    api.get('/guild/roles', (_req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        res.json([...guild.roles.cache.values()]
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size, managed: r.managed })));
    });

    api.get('/guild/channels', (_req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        res.json([...guild.channels.cache.values()]
            .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .sort((a, b) => ('position' in a ? a.position : 0) - ('position' in b ? b.position : 0))
            .map(c => ({ id: c.id, name: c.name, category: c.parent?.name ?? null })));
    });

    api.get('/guild/categories', (_req, res) => {
        const guild = client.guilds.cache.get(env.guildId);
        if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        res.json([...guild.channels.cache.values()]
            .filter(c => c.type === ChannelType.GuildCategory)
            .sort((a, b) => ('position' in a ? a.position : 0) - ('position' in b ? b.position : 0))
            .map(c => ({ id: c.id, name: c.name })));
    });

    // ── Módulos (activar / desactivar en caliente) ──
    api.get('/modules', (_req, res) => res.json(manager.list()));
    api.post('/modules/:id/enabled', asyncRoute(async (req, res) => {
        await manager.setEnabled(String(req.params.id), bool(req.body?.enabled));
        res.json(manager.list());
    }));

    // ── Registros ──
    api.get('/logs', (req, res) => {
        const level = (['debug', 'info', 'warn', 'error'] as const).includes(req.query.level as LogLevel) ? (req.query.level as LogLevel) : 'info';
        res.json(getLogs(level, Math.min(Number(req.query.limit) || 300, 1000)));
    });

    // ── Archivos (subida y descarga) ──
    const upload = multer({
        storage: multer.diskStorage({
            destination: UPLOADS_DIR,
            filename: (_req, file, cb) => {
                file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
                cb(null, `${crypto.randomUUID()}-${safeName(file.originalname)}`);
            },
        }),
        limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 10 },
    });

    api.post('/files', upload.array('files', 10), (req, res) => {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (!files.length) throw new HttpError(400, 'No se recibió ningún archivo.');
        const rows = files.map(f => registerFile(db, { name: f.originalname, mime: f.mimetype, size: f.size, path: f.path }));
        res.status(201).json(rows.map(toFileInfo));
    });

    api.get('/files/:id', (req, res) => {
        const file = getFile(db, String(req.params.id));
        if (!file) throw new HttpError(404, 'Archivo no encontrado');
        if (!file.path || !fs.existsSync(file.path)) {
            if (file.url) return res.redirect(file.url);
            throw new HttpError(404, 'El archivo ya no está en el servidor');
        }
        const inline = isInlineImage(file.mime);
        res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.sendFile(path.resolve(file.path), { dotfiles: 'allow' });
    });

    // ── Rutas de cada módulo: GET siempre disponible, acciones solo con el módulo activo ──
    for (const mod of manager.modules()) {
        if (!mod.router) continue;
        api.use(`/${mod.id}`, (req, res, next) => {
            if (req.method !== 'GET' && !manager.isRunning(mod.id)) {
                res.status(409).json({ error: `El módulo "${mod.name}" está desactivado. Actívalo en la sección Módulos.` });
                return;
            }
            next();
        }, mod.router);
    }

    api.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
    app.use('/api', api);

    // ── Frontend compilado (SPA) ──
    const webDist = path.resolve(__dirname, '../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist, { index: false, maxAge: '1h' }));
        app.use((req, res, next) => {
            if (req.method !== 'GET') return next();
            res.sendFile(path.join(webDist, 'index.html'));
        });
    } else {
        app.get('/', (_req, res) => {
            res.status(200).send('Panel sin compilar. Ejecuta "npm run build:web" (o "npm run dev:web" para desarrollo).');
        });
    }

    // ── Gestión de errores ──
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        void _next;
        if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
        if (err instanceof BotError) return void res.status(409).json({ error: err.message });
        if (err instanceof multer.MulterError) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el máximo de ${env.maxUploadMb} MB.` : `Error al subir archivos (${err.code}).`;
            return void res.status(400).json({ error: msg });
        }
        if ((err as { type?: string })?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON no válido' });
        logger.error('Error no controlado en el panel', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    });

    // ── Servidor HTTP + WebSocket en tiempo real ──
    // Solo los WebSocket del panel pasan al evento 'upgrade'. El resto (p. ej. "Upgrade: h2c", que manda el HttpClient
    // de Java del mod de Minecraft con http://) se atiende como una petición normal; si no, acababa en un 401 vacío.
    const isWebSocket = (req: http.IncomingMessage) => (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const server = http.createServer({ shouldUpgradeCallback: isWebSocket } as http.ServerOptions, app);
    const wss = new WebSocketServer({ noServer: true });

    const sockets = new WeakMap<WebSocket, { userId: string; access: PanelAccess }>();

    server.on('upgrade', async (req, socket, head) => {
        if (!isWebSocket(req)) {
            // Versiones de Node sin shouldUpgradeCallback: al menos queda claro en el log qué ha pasado.
            logger.warn(`Petición rechazada a ${req.url}: pide "Upgrade: ${req.headers.upgrade}" y solo se admite WebSocket (actualiza Node o usa HTTP/1.1 en el cliente)`);
            socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"Upgrade no soportado: usa HTTP/1.1"}');
            return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const origin = req.headers.origin;
        const sameOrigin = !origin || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
        const session = url.pathname === '/ws' && sameOrigin ? sessionFromRequest(db, req) : undefined;
        const access = session ? await resolveAccess(client, db, session.userId).catch(() => null) : null;
        if (!session || !access) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            sockets.set(ws, { userId: session.userId, access });
            wss.emit('connection', ws, req);
        });
    });

    const alive = new WeakSet<WebSocket>();
    wss.on('connection', ws => {
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        ws.on('error', () => undefined);
    });

    const onEvent = (e: BusEvent) => {
        const data = JSON.stringify(e);
        for (const ws of wss.clients) {
            if (ws.readyState !== ws.OPEN) continue;
            if (sockets.get(ws)?.access === 'owner' || STAFF_EVENTS.has(e.type)) ws.send(data);
        }
    };
    bus.on('event', onEvent);

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!alive.has(ws)) { ws.terminate(); continue; }
            alive.delete(ws);
            ws.ping();
            const info = sockets.get(ws);
            if (info) {
                void resolveAccess(client, db, info.userId).then(access => {
                    if (access) info.access = access;
                    else ws.terminate();
                }).catch(() => ws.terminate());
            }
        }
    }, 30_000);
    heartbeat.unref();

    purgeExpiredSessions(db);
    setInterval(() => purgeExpiredSessions(db), 3600_000).unref();

    server.listen(env.panel.port, env.panel.host, () => {
        logger.info(`🌐 Panel disponible en ${env.panel.url} (escuchando en ${env.panel.host}:${env.panel.port})`);
    });
    server.on('error', err => logger.error('No se pudo iniciar el panel web', err));
    return server;
}
