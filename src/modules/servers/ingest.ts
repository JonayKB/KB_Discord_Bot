import crypto from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../../core/db';
import { HttpError } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { parsePayload, type McStatsService } from './stats';

const logger = new Logger('McStatsIngest');

/**
 * La key sin revelarla: principio, final y longitud, para compararla con la del mod.
 * Avisa de lo que suele romperse al copiarla (comillas, prefijo, longitud).
 */
export function describeKey(key: string): string {
    const shown = key.length <= 12 ? '*'.repeat(key.length) : `${key.slice(0, 8)}…${key.slice(-4)}`;
    const notes = [`${key.length} caracteres`];
    if (/["']/.test(key)) notes.push('tiene comillas');
    if (!key.startsWith('kbs_')) notes.push('no empieza por kbs_');
    else if (key.length !== 47) notes.push('deberían ser 47');
    return `${shown} (${notes.join(', ')})`;
}

/** Un aviso por motivo y origen cada 10 min, para no llenar el log con los reintentos del mod. */
const lastWarned = new Map<string, number>();
function warnAuth(req: Request, reason: string): void {
    const from = `${req.ip ?? '?'} · ${req.get('user-agent') ?? '?'}`;
    const id = `${from}|${reason}`;
    const now = Date.now();
    if (now - (lastWarned.get(id) ?? 0) < 10 * 60_000) return;
    for (const [k, t] of lastWarned) if (now - t >= 10 * 60_000) lastWarned.delete(k);
    lastWarned.set(id, now);
    logger.warn(`🔑 Estadísticas rechazadas (${from}): ${reason}`);
}

/** Peticiones por minuto y key. */
const RATE_LIMIT = 30;

/**
 * POST /api/integrations/minecraft/stats — lo llama el mod kb_discord_auth.
 * Fuera de la sesión del panel: solo acepta la API key del servidor (Authorization: Bearer).
 */
export function createStatsIngestRouter(db: DB, getService: () => McStatsService | null): Router {
    const router = Router();
    const windows = new Map<string, { start: number; count: number }>(); // por SHA-256 de la key

    router.post('/', (req, res, next) => {
        const service = getService();
        if (!service) throw new HttpError(503, 'El módulo "Servidores de juego" está desactivado');

        const header = req.get('authorization');
        const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
        if (!m) {
            const reason = header ? 'la cabecera Authorization no tiene el formato "Bearer <key>"' : 'falta la cabecera Authorization';
            warnAuth(req, reason);
            throw new HttpError(401, `API key no válida: ${reason}`);
        }
        const serverId = service.serverForKey(m[1]);
        if (!serverId) {
            const reason = `ningún servidor tiene la key ${describeKey(m[1])}; ¿se regeneró o es de otro panel?`;
            warnAuth(req, reason);
            throw new HttpError(401, `API key no válida: ${reason}`);
        }

        const server = db.prepare('SELECT name, type FROM game_servers WHERE id = ?').get(serverId) as { name: string; type: string } | undefined;
        if (!server || server.type !== 'minecraft') {
            const reason = `la key es del servidor #${serverId}${server ? ` ("${server.name}", ${server.type})` : ''}, que no es de Minecraft`;
            warnAuth(req, reason);
            throw new HttpError(403, `API key no válida: ${reason}`);
        }

        const now = Date.now();
        const id = crypto.createHash('sha256').update(m![1]).digest('hex');
        for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
        const w = windows.get(id);
        if (!w) windows.set(id, { start: now, count: 1 });
        else if (++w.count > RATE_LIMIT) {
            res.setHeader('Retry-After', String(Math.ceil((w.start + 60_000 - now) / 1000)));
            throw new HttpError(429, 'Demasiadas peticiones');
        }

        (req as Request & { mcServerId?: number }).mcServerId = serverId;
        next();
    }, express.json({ limit: '1mb', type: () => true }), (req, res) => {
        const service = getService()!;
        const serverId = (req as Request & { mcServerId?: number }).mcServerId!;
        const payload = parsePayload(req.body);
        const result = service.ingest(serverId, payload);
        logger.debug(`📈 ${payload.server.name} (${payload.server.id}): ${result.accepted} aceptados, ${result.ignored} ignorados · ${req.get('user-agent') ?? '?'}`);
        res.json(result);
    });

    router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
        void _next;
        const type = (err as { type?: string })?.type;
        if (err instanceof HttpError) {
            if (err.status === 400) logger.warn(`Envío de estadísticas rechazado (${req.get('user-agent') ?? '?'}): ${err.message}`);
            return void res.status(err.status).json({ error: err.message });
        }
        if (type === 'entity.too.large') return void res.status(413).json({ error: 'El cuerpo supera 1 MB' });
        if (type === 'entity.parse.failed') return void res.status(400).json({ error: 'JSON no válido' });
        if (type === 'encoding.unsupported' || type === 'charset.unsupported') return void res.status(400).json({ error: 'Codificación no soportada' });
        logger.error('Error al guardar las estadísticas', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    });

    return router;
}
