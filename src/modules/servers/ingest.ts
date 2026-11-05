import crypto from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../../core/db';
import { HttpError } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { parsePayload, type McStatsService } from './stats';

const logger = new Logger('McStatsIngest');

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

        const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
        const serverId = m ? service.serverForKey(m[1]) : null;
        if (!serverId) throw new HttpError(401, 'API key no válida');

        const server = db.prepare('SELECT type FROM game_servers WHERE id = ?').get(serverId) as { type: string } | undefined;
        if (!server || server.type !== 'minecraft') throw new HttpError(403, 'La key no corresponde a un servidor de Minecraft');

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
