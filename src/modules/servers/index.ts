import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import { Logger } from '../../utils/Logger';
import { queryServer, type ServerKind } from './query';
import { MAX_INTERVAL, MIN_INTERVAL, type GameServerInput, type ServersService } from './service';
import type { WhitelistService } from './whitelist';
import { PERIODS, STAT_KEYS, type Period, type StatKey } from './ranking';
import type { LeaderboardInput, McStatsService } from './stats';

export { ServersService } from './service';
export { WhitelistService } from './whitelist';
export { McStatsService } from './stats';

const logger = new Logger('Module:servers');

/* eslint-disable @typescript-eslint/no-explicit-any */

const optPort = (v: unknown, field: string): number | null =>
    v === undefined || v === null || v === '' ? null : int(v, field, { min: 1, max: 65535 });

function parseServer(body: any): GameServerInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos del servidor no válidos');
    const type = body.type as ServerKind;
    if (type !== 'minecraft' && type !== 'hytale') throw new HttpError(400, 'El tipo debe ser "minecraft" o "hytale"');
    // Se acepta "mc.midominio.com:25565" o con http(s):// delante y se limpia.
    let host = str(body.host, 'host', { required: true, max: 255 }).trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    let port = optPort(body.port, 'port');
    const m = /^([^:]+):(\d{1,5})$/.exec(host);
    if (m) { host = m[1]; port ??= Number(m[2]); }
    if (!host) throw new HttpError(400, 'Falta la IP o dominio del servidor');
    const apiPort = optPort(body.apiPort, 'apiPort');
    if (type === 'hytale' && !apiPort) throw new HttpError(400, 'Para Hytale hace falta el puerto de la API (Nitrado Query).');
    return {
        name: str(body.name, 'name', { required: true, max: 60 }).trim(),
        type,
        host,
        port: type === 'minecraft' ? port : null,
        apiPort,
        enabled: body.enabled === undefined ? true : bool(body.enabled),
        linkPlayers: body.linkPlayers === undefined ? true : bool(body.linkPlayers),
    };
}

function parseLeaderboard(body: any): LeaderboardInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos del ranking no válidos');
    const pick = <T extends string>(v: unknown, allowed: readonly T[], field: string): T[] => {
        if (v === undefined) return [...allowed];
        if (!Array.isArray(v) || v.some(x => !allowed.includes(x))) throw new HttpError(400, `"${field}" no es válido`);
        const out = allowed.filter(a => v.includes(a));
        if (!out.length) throw new HttpError(400, `Elige al menos un valor en "${field}"`);
        return out;
    };
    const exclude = body.exclude === undefined ? [] : body.exclude;
    if (!Array.isArray(exclude) || exclude.length > 200 || exclude.some((x: unknown) => typeof x !== 'string' || x.length > 64)) {
        throw new HttpError(400, '"exclude" debe ser una lista de UUID o nombres');
    }
    return {
        enabled: body.enabled === undefined ? true : bool(body.enabled),
        channelId: str(body.channelId, 'channelId', { required: true, max: 32 }),
        stats: pick<StatKey>(body.stats, STAT_KEYS, 'stats'),
        periods: pick<Period>(body.periods, PERIODS, 'periods'),
        top: body.top === undefined ? 10 : int(body.top, 'top', { min: 1, max: 25 }),
        intervalMin: body.intervalMin === undefined ? 15 : int(body.intervalMin, 'intervalMin', { min: 5, max: 1440 }),
        title: (str(body.title, 'title', { max: 200 }).trim() || '🏆 {server}'),
        linkedOnly: bool(body.linkedOnly),
        exclude: [...new Set(exclude.map((x: string) => x.trim()).filter(Boolean))] as string[],
    };
}

export function createServersModule(service: ServersService, whitelist: WhitelistService, stats: McStatsService): BotModule {
    const router = Router();
    const sid = (v: unknown) => int(v, 'id', { min: 1 });
    const who = (req: any) => String(req.session?.username ?? 'panel');

    router.get('/', (_req, res) => {
        res.json({
            intervalSec: service.intervalSec(),
            servers: service.list().map(s => ({ ...s, status: service.statusOf(s.id), rcon: whitelist.rconInfo(s.id) })),
        });
    });

    router.put('/settings', (req, res) => {
        const sec = int(req.body?.intervalSec, 'intervalSec', { min: MIN_INTERVAL, max: MAX_INTERVAL });
        res.json({ intervalSec: service.setIntervalSec(sec) });
    });

    /** Prueba una configuración sin guardarla. */
    router.post('/test', asyncRoute(async (req, res) => {
        const s = parseServer({ name: 'test', ...req.body });
        res.json(await queryServer(s));
    }));

    router.post('/', (req, res) => {
        res.status(201).json(service.create(parseServer(req.body)));
    });

    router.put('/:id', (req, res) => {
        res.json(service.update(int(req.params.id, 'id', { min: 1 }), parseServer(req.body)));
    });

    router.delete('/:id', (req, res) => {
        service.delete(int(req.params.id, 'id', { min: 1 }));
        res.json({ ok: true });
    });

    router.get('/:id/history', (req, res) => {
        res.json(service.history(int(req.params.id, 'id', { min: 1 }), String(req.query.range ?? '24h')));
    });

    // ── RCON ──
    router.put('/:id/rcon', (req, res) => {
        const port = optPort(req.body?.port, 'port');
        // Si no se envía contraseña se conserva la guardada; "" la borra.
        const password = req.body?.password === undefined || req.body?.password === null ? undefined : str(req.body.password, 'password', { max: 200 });
        res.json(whitelist.setRcon(sid(req.params.id), port, password));
    });

    router.post('/:id/rcon/test', asyncRoute(async (req, res) => {
        const [out] = await whitelist.run(sid(req.params.id), ['list']);
        res.json({ ok: true, output: out });
    }));

    router.post('/:id/rcon/command', asyncRoute(async (req, res) => {
        const command = str(req.body?.command, 'command', { required: true, max: 500 });
        res.json({ output: await whitelist.console(sid(req.params.id), command, who(req)) });
    }));

    // ── Whitelist ──
    router.get('/:id/whitelist', (req, res) => {
        const id = sid(req.params.id);
        res.json({ settings: whitelist.settings(id), entries: whitelist.entries(id, bool(req.query.history)) });
    });

    router.put('/:id/whitelist/settings', (req, res) => {
        const b = req.body ?? {};
        res.json(whitelist.setSettings({
            serverId: sid(req.params.id),
            enabled: bool(b.enabled),
            campaignId: b.campaignId ? int(b.campaignId, 'campaignId', { min: 1 }) : null,
            onlineMode: b.onlineMode === undefined ? true : bool(b.onlineMode),
            allowRename: bool(b.allowRename),
            renameCooldownDays: b.renameCooldownDays === undefined ? 30 : int(b.renameCooldownDays, 'renameCooldownDays', { min: 0, max: 365 }),
            removeOnLeave: b.removeOnLeave === undefined ? true : bool(b.removeOnLeave),
        }));
    });

    router.post('/:id/whitelist', asyncRoute(async (req, res) => {
        const userId = str(req.body?.userId, 'userId', { required: true, max: 32 });
        const name = str(req.body?.name, 'name', { required: true, max: 32 });
        res.status(201).json(await whitelist.addFromPanel(sid(req.params.id), userId, name, who(req)));
    }));

    router.delete('/:id/whitelist/:entryId', (req, res) => {
        whitelist.removeEntry(int(req.params.entryId, 'entryId', { min: 1 }), who(req));
        res.json({ ok: true });
    });

    router.post('/:id/whitelist/import', asyncRoute(async (req, res) => res.json(await whitelist.importConfirmed(sid(req.params.id), who(req)))));

    router.post('/:id/whitelist/process', asyncRoute(async (req, res) => {
        await whitelist.process(sid(req.params.id));
        res.json({ entries: whitelist.entries(sid(req.params.id)) });
    }));

    /** Lo que hay de verdad en la whitelist del servidor, marcando qué nombres no están vinculados a nadie. */
    router.get('/:id/whitelist/server', asyncRoute(async (req, res) => {
        const id = sid(req.params.id);
        const names = await whitelist.serverList(id);
        const linked = new Map(whitelist.entries(id).filter(e => e.status === 'active').map(e => [e.mcName.toLowerCase(), e]));
        res.json(names.map(n => ({ name: n, userId: linked.get(n.toLowerCase())?.userId ?? null, username: linked.get(n.toLowerCase())?.username ?? null })));
    }));

    // ── Estadísticas de jugadores (mod kb_discord_auth) y rankings ──
    const mcServer = (v: unknown) => {
        const s = service.require(sid(v));
        if (s.type !== 'minecraft') throw new HttpError(400, 'Las estadísticas de jugadores solo están disponibles en Minecraft.');
        return s;
    };

    router.get('/:id/stats', (req, res) => res.json(stats.overview(mcServer(req.params.id).id)));

    /** Genera o regenera la API key (se muestra una sola vez). */
    router.post('/:id/stats/key', (req, res) => {
        const s = mcServer(req.params.id);
        const key = stats.generateKey(s.id);
        logger.info(`🔑 ${who(req)} ha generado una API key de estadísticas para "${s.name}"`);
        res.json({ key, endpoint: stats.endpoint() });
    });

    router.delete('/:id/stats/key', (req, res) => {
        const s = mcServer(req.params.id);
        stats.revokeKey(s.id);
        logger.info(`🔑 ${who(req)} ha revocado la API key de estadísticas de "${s.name}"`);
        res.json({ ok: true });
    });

    router.delete('/:id/stats/players/:uuid', (req, res) => {
        stats.deletePlayer(mcServer(req.params.id).id, String(req.params.uuid));
        res.json({ ok: true });
    });

    router.post('/:id/leaderboards', (req, res) => {
        res.status(201).json(stats.createLeaderboard(mcServer(req.params.id).id, parseLeaderboard(req.body)));
    });

    router.put('/:id/leaderboards/:lbId', (req, res) => {
        res.json(stats.updateLeaderboard(mcServer(req.params.id).id, int(req.params.lbId, 'lbId', { min: 1 }), parseLeaderboard(req.body)));
    });

    router.delete('/:id/leaderboards/:lbId', (req, res) => {
        stats.deleteLeaderboard(mcServer(req.params.id).id, int(req.params.lbId, 'lbId', { min: 1 }));
        res.json({ ok: true });
    });

    router.post('/:id/leaderboards/:lbId/publish', asyncRoute(async (req, res) => {
        const s = mcServer(req.params.id);
        const lbId = int(req.params.lbId, 'lbId', { min: 1 });
        stats.leaderboard(lbId, s.id);
        res.json(await stats.publishLeaderboard(lbId));
    }));

    router.post('/:id/check', asyncRoute(async (req, res) => {
        res.json(await service.check(int(req.params.id, 'id', { min: 1 })));
    }));

    router.post('/:id/message', asyncRoute(async (req, res) => {
        const channelId = str(req.body?.channelId, 'channelId', { required: true, max: 32 });
        res.json(await service.createMessage(int(req.params.id, 'id', { min: 1 }), channelId));
    }));

    router.post('/:id/message/unlink', (req, res) => {
        res.json(service.unlinkMessage(int(req.params.id, 'id', { min: 1 })));
    });

    return {
        id: 'servers',
        name: 'Servidores de juego',
        description: 'Consulta el estado de tus servidores de Minecraft y Hytale (jugadores, latencia, TPS…), lo muestra en el panel y mantiene actualizado un mensaje de estado en Discord. En Minecraft, consola RCON y whitelist automática a partir de las confirmaciones, y rankings de jugadores con las estadísticas que envía el mod kb_discord_auth.',
        router,
        start(ctx) {
            service.start();
            whitelist.start();
            stats.start();
            ctx.listen('guildMemberRemove', m => whitelist.onMemberLeave(m.id));
            ctx.listen('interactionCreate', i => stats.handleInteraction(i));
            ctx.onStop(() => { service.stop(); whitelist.stop(); stats.stop(); });
        },
    };
}
