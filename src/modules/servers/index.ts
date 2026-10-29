import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import { queryServer, type ServerKind } from './query';
import { MAX_INTERVAL, MIN_INTERVAL, type GameServerInput, type ServersService } from './service';

export { ServersService } from './service';

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

export function createServersModule(service: ServersService): BotModule {
    const router = Router();

    router.get('/', (_req, res) => {
        res.json({
            intervalSec: service.intervalSec(),
            servers: service.list().map(s => ({ ...s, status: service.statusOf(s.id) })),
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
        description: 'Consulta el estado de tus servidores de Minecraft y Hytale (jugadores, latencia, TPS…), lo muestra en el panel y mantiene actualizado un mensaje de estado en Discord.',
        router,
        start(ctx) {
            service.start();
            ctx.onStop(() => service.stop());
        },
    };
}
