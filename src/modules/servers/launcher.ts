import { Router, type Request } from 'express';
import { HttpError } from '../../core/http';
import type { ServersService, GameServer } from './service';
import { STAT_KEYS, PERIODS, type Period, type StatKey } from './ranking';
import type { McStatsService, PlayerStats } from './stats';

/**
 * Datos públicos (sin sesión) que lee KB MC Launcher en la pantalla de cada modpack.
 * El contrato está en docs/launcher-contract.md; si cambia el formato, sube LAUNCHER_FORMAT_VERSION
 * y actualiza a la vez el launcher, o las versiones instaladas dejarán de mostrarlo.
 */
export const LAUNCHER_FORMAT_VERSION = 1;

/** Peticiones por minuto e IP a la ficha de un jugador (el estado es barato y no se limita). */
const PLAYER_RATE_LIMIT = 30;
/** Nombres de Minecraft: en servidores no premium puede haber caracteres raros, pero no barras ni control. */
const NAME_RE = /^[^\s/\\\u0000-\u001f]{1,16}$/;

/** Solo se publica lo de servidores de Minecraft activos con dirección pública: ya la ven todos en Discord. */
function isPublic(s: GameServer): s is GameServer & { publicAddress: string } {
    return s.enabled && s.type === 'minecraft' && !!s.publicAddress?.trim();
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function createLauncherRouter(getServices: () => { servers: ServersService; mcStats: McStatsService } | null): Router {
    const router = Router();
    const windows = new Map<string, { start: number; count: number }>();

    function services() {
        const s = getServices();
        if (!s) throw new HttpError(503, 'El módulo "Servidores de juego" está desactivado');
        return s;
    }

    function rateLimit(req: Request): void {
        const key = req.ip ?? '?';
        const now = Date.now();
        const w = windows.get(key);
        if (!w || now - w.start >= 60_000) {
            if (windows.size > 5000) windows.clear();
            windows.set(key, { start: now, count: 1 });
            return;
        }
        if (++w.count > PLAYER_RATE_LIMIT) throw new HttpError(429, 'Demasiadas peticiones');
    }

    // GET /servers/status.json — estado de cada servidor público
    router.get('/status.json', (_req, res) => {
        const { servers } = services();
        const list = servers.list().filter(isPublic).map(s => {
            const st = servers.statusOf(s.id);
            return {
                id: s.id,
                name: s.name,
                address: s.publicAddress.trim(),
                online: st?.online ?? false,
                checkedAt: iso(st?.checkedAt),
                playersOnline: st?.playersOnline ?? 0,
                maxPlayers: st?.maxPlayers ?? 0,
                // Solo nombres: el Discord de cada uno no se publica
                players: (st?.players ?? []).map(p => p.name),
                playerListComplete: st?.playerListComplete ?? false,
                tps: st?.tps ? Math.round(st.tps.m1 * 10) / 10 : null,
                mapUrl: s.mapUrl,
                inviteUrl: s.inviteUrl,
                opensAt: iso(s.opensAt),
            };
        });
        res.setHeader('Cache-Control', 'no-cache');
        res.json({ version: LAUNCHER_FORMAT_VERSION, updatedAt: new Date().toISOString(), servers: list });
    });

    // GET /servers/:id/players/:name — estadísticas y puesto de un jugador
    router.get('/:id/players/:name', (req, res) => {
        rateLimit(req);
        const { servers, mcStats } = services();
        const id = Number(req.params.id);
        const name = String(req.params.name);
        const server = Number.isInteger(id) ? servers.get(id) : null;
        if (!server || !isPublic(server)) throw new HttpError(404, 'Servidor no encontrado');
        if (!NAME_RE.test(name)) throw new HttpError(400, 'Nombre no válido');

        const all = mcStats.players(id);
        // El UUID offline depende de las mayúsculas: primero el nombre exacto y, si no, sin distinguirlas (solo si es único)
        const lower = name.toLowerCase();
        const loose = all.filter(p => p.name.toLowerCase() === lower);
        const player: PlayerStats | undefined = all.find(p => p.name === name) ?? (loose.length === 1 ? loose[0] : undefined);
        res.setHeader('Cache-Control', 'no-cache');
        if (!player) throw new HttpError(404, 'Sin estadísticas de ese jugador');

        // Mismos filtros que el ranking que se publica en Discord (el primero activo de ese servidor)
        const board = mcStats.leaderboards(id).find(l => l.enabled);
        const opts = board ? { linkedOnly: board.linkedOnly, exclude: board.exclude } : {};
        const rank = {} as Record<Period, Partial<Record<StatKey, number | null>>>;
        const ranked = {} as Record<Period, number>;
        for (const period of PERIODS) {
            rank[period] = {};
            let most = 0;
            for (const key of STAT_KEYS) {
                const rows = mcStats.ranking(id, key, period, opts, all);
                most = Math.max(most, rows.length);
                const pos = rows.findIndex(r => r.uuid === player.uuid);
                rank[period][key] = pos === -1 ? null : pos + 1;
            }
            ranked[period] = most;
        }

        res.json({
            version: LAUNCHER_FORMAT_VERSION,
            name: player.name,
            updatedAt: iso(player.takenAt),
            total: player.total,
            weekly: player.weekly,
            rank,
            rankedPlayers: ranked,
        });
    });

    router.use((_req, res) => void res.status(404).json({ error: 'No encontrado' }));
    return router;
}
