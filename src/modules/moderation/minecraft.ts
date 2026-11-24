import type http from 'node:http';
import type { Duplex } from 'node:stream';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { bus, type BusEvent } from '../../core/bus';
import type { DB } from '../../core/db';
import { HttpError, int, str } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { authorizeServerKey } from '../servers/ingest';
import type { McStatsService } from '../servers/stats';
import { MC_ACTIONS, type McAction, type ModerationService } from './service';

const logger = new Logger('McModeration');

/** Ruta pública (autenticada con la API key del servidor) que usa el mod kb_moderation. */
export const MC_MODERATION_PATH = '/api/integrations/minecraft/moderation';

/** WebSocket de los servidores: avisa en cuanto hay algo nuevo en el feed, así el mod no tiene que preguntar cada pocos segundos. */
export const MC_MODERATION_WS_PATH = `${MC_MODERATION_PATH}/ws`;

/** IDs de Discord: solo dígitos (los reales tienen 17-20; los de la demo y las pruebas son más cortos). */
const SNOWFLAKE = /^\d{1,25}$/;
/** Peticiones por minuto y servidor (sin el WebSocket, el mod consulta el feed cada pocos segundos). */
const RATE_LIMIT = 240;

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Sanciones y reportes compartidos con los servidores de Minecraft:
 *  - POST /actions  una sanción hecha en el juego (se aplica en Discord y queda como caso)
 *  - GET  /feed     lo que ha pasado en el bot desde `after` (casos nuevos y borrados, reportes cerrados)
 *  - WS   /ws       avisa ({"type":"feed"}) cada vez que hay algo nuevo en el feed; el mod lo lee entonces
 *  - POST /reports  un /report del juego · POST /reports/close  cerrado en el juego
 */
export function createMcModerationRouter(
    db: DB,
    getStats: () => McStatsService | null,
    getModeration: () => ModerationService | null,
): Router {
    const router = Router();
    const windows = new Map<number, { start: number; count: number }>();

    router.use((req, _res, next) => {
        const stats = getStats();
        if (!stats) throw new HttpError(503, 'El módulo "Servidores de juego" está desactivado');
        if (!getModeration()) throw new HttpError(503, 'El módulo "Moderación" está desactivado');
        const serverId = authorizeServerKey(db, stats, req);
        const now = Date.now();
        for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
        const w = windows.get(serverId);
        if (!w) windows.set(serverId, { start: now, count: 1 });
        else if (++w.count > RATE_LIMIT) throw new HttpError(429, 'Demasiadas peticiones');
        (req as Request & { mcServerId?: number }).mcServerId = serverId;
        next();
    }, express.json({ limit: '64kb', type: () => true }));

    const serverOf = (req: Request) => (req as Request & { mcServerId?: number }).mcServerId!;
    const optSnowflake = (v: unknown, name: string): string | null => {
        const s = str(v, name, { max: 32 }).trim();
        if (!s) return null;
        if (!SNOWFLAKE.test(s)) throw new HttpError(400, `${name} no es un ID de Discord`);
        return s;
    };

    router.post('/actions', (req, res, next) => {
        const b = req.body as any ?? {};
        const action = b.action as McAction;
        if (!MC_ACTIONS.includes(action)) throw new HttpError(400, 'Acción no válida');
        const ref = str(b.ref, 'ref', { required: true, max: 64 });
        const userId = optSnowflake(b.userId, 'userId');
        if (!userId) throw new HttpError(400, 'Falta userId (la cuenta de Discord del jugador)');
        getModeration()!.fromMinecraft(serverOf(req), {
            ref,
            action,
            userId,
            mcName: str(b.mcName, 'mcName', { max: 32 }) || null,
            reason: str(b.reason, 'reason', { max: 500 }),
            durationMs: b.durationMs === undefined || b.durationMs === null ? undefined : int(b.durationMs, 'durationMs', { min: 0, max: 10 * 365 * 86_400_000 }),
            expiresAt: b.expiresAt === undefined || b.expiresAt === null ? null : int(b.expiresAt, 'expiresAt', { min: 0 }),
            caseId: b.caseId === undefined || b.caseId === null ? undefined : int(b.caseId, 'caseId', { min: 1 }),
            moderator: {
                discordId: optSnowflake(b.moderator?.discordId, 'moderator.discordId'),
                name: str(b.moderator?.name, 'moderator.name', { max: 64 }) || 'Minecraft',
            },
        }).then(r => res.json(r), next);
    });

    router.get('/feed', (req, res) => {
        const after = req.query.after ? int(req.query.after, 'after', { min: 0 }) : 0;
        res.json(getModeration()!.feed(serverOf(req), after));
    });

    router.post('/reports', (req, res) => {
        const b = req.body as any ?? {};
        const report = getModeration()!.addReport(serverOf(req), {
            ref: str(b.ref, 'ref', { required: true, max: 64 }),
            reporterName: str(b.reporterName, 'reporterName', { required: true, max: 32 }),
            reporterDiscordId: optSnowflake(b.reporterDiscordId, 'reporterDiscordId'),
            targetName: str(b.targetName, 'targetName', { required: true, max: 32 }),
            targetDiscordId: optSnowflake(b.targetDiscordId, 'targetDiscordId'),
            reason: str(b.reason, 'reason', { required: true, max: 500 }),
            location: str(b.location, 'location', { max: 120 }) || null,
        });
        res.json({ id: report.id });
    });

    router.post('/reports/close', (req, res) => {
        const b = req.body as any ?? {};
        getModeration()!.closeReportFromServer(serverOf(req), str(b.ref, 'ref', { required: true, max: 64 }), str(b.by, 'by', { max: 64 }) || 'Minecraft');
        res.json({ ok: true });
    });

    router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
        void _next;
        const type = (err as { type?: string })?.type;
        if (err instanceof HttpError) {
            if (err.status === 400) logger.warn(`Petición de Minecraft rechazada (${req.method} ${req.path}): ${err.message}`);
            return void res.status(err.status).json({ error: err.message });
        }
        if (type === 'entity.too.large') return void res.status(413).json({ error: 'El cuerpo es demasiado grande' });
        if (type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON no válido' });
        logger.error('Error en la moderación de Minecraft', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    });

    return router;
}

/**
 * WebSocket de los servidores de Minecraft (GET /ws con "Authorization: Bearer <key>").
 * No lleva datos: solo dice "hay algo nuevo" y el mod lo lee con GET /feed desde su cursor. Así el feed sigue siendo
 * la única fuente (y lo que pase con el socket caído se recupera al reconectar, que el mod lee el feed al conectar).
 * Devuelve el manejador del evento 'upgrade' para esa ruta.
 */
export function createMcModerationSocket(
    db: DB,
    getStats: () => McStatsService | null,
    getModeration: () => ModerationService | null,
): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
    const wss = new WebSocketServer({ noServer: true });
    const alive = new WeakSet<WebSocket>();

    wss.on('connection', ws => {
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        ws.on('error', () => undefined);
    });

    // Todo lo que añade un evento al feed (casos nuevos o borrados, reportes cerrados) publica uno de estos.
    bus.on('event', (e: BusEvent) => {
        if (e.type !== 'moderation:cases' && e.type !== 'moderation:reports') return;
        for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send('{"type":"feed"}');
    });

    // Ping cada 30 s: aquí corta los sockets muertos y el mod sabe que el suyo sigue vivo.
    setInterval(() => {
        for (const ws of wss.clients) {
            if (!alive.has(ws)) { ws.terminate(); continue; }
            alive.delete(ws);
            ws.ping();
        }
    }, 30_000).unref();

    const refuse = (socket: Duplex, status: number, message: string) => {
        const body = JSON.stringify({ error: message });
        socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\n`
            + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };

    return (req, socket, head) => {
        const stats = getStats();
        if (!stats) return refuse(socket, 503, 'El módulo "Servidores de juego" está desactivado');
        if (!getModeration()) return refuse(socket, 503, 'El módulo "Moderación" está desactivado');
        // authorizeServerKey lee la cabecera y la IP como en una petición de Express.
        const header = (name: string) => {
            const v = req.headers[name.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
        };
        let serverId: number;
        try {
            serverId = authorizeServerKey(db, stats, { get: header, ip: req.socket.remoteAddress } as unknown as Request);
        } catch (err) {
            return refuse(socket, err instanceof HttpError ? err.status : 401, (err as Error).message);
        }
        wss.handleUpgrade(req, socket, head, ws => {
            logger.info(`Servidor de Minecraft #${serverId} conectado al WebSocket de moderación`);
            ws.on('close', () => logger.info(`Servidor de Minecraft #${serverId} desconectado del WebSocket de moderación`));
            wss.emit('connection', ws, req);
        });
    };
}
