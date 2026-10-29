import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import { BEHAVIORS, type Behavior, type PanelInput, type PanelSource, type ReactionRolesService } from './service';

export { ReactionRolesService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SNOWFLAKE = /^\d{17,21}$/;

function parsePanel(body: any): PanelInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos no válidos');
    if (!Array.isArray(body.entries)) throw new HttpError(400, '"entries" debe ser una lista');
    if (body.entries.length > 40) throw new HttpError(400, 'Demasiadas reacciones');
    const color = str(body.color, 'color', { max: 7 }) || '#5865F2';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'El color debe ser HEX (#RRGGBB)');
    return {
        name: str(body.name, 'name', { required: true, max: 80 }).trim(),
        enabled: body.enabled === undefined ? true : bool(body.enabled),
        exclusive: bool(body.exclusive),
        title: str(body.title, 'title', { max: 256 }).trim(),
        description: str(body.description, 'description', { max: 3000 }),
        color,
        showList: body.showList === undefined ? true : bool(body.showList),
        entries: body.entries.map((e: any, i: number) => {
            const behavior = (e?.behavior ?? 'toggle') as Behavior;
            if (!BEHAVIORS.includes(behavior)) throw new HttpError(400, `Comportamiento no válido en la reacción ${i + 1}`);
            return {
                emoji: str(e?.emoji, `entries[${i}].emoji`, { required: true, max: 64 }),
                roleId: str(e?.roleId, `entries[${i}].roleId`, { required: true, max: 32 }),
                behavior,
                label: str(e?.label, `entries[${i}].label`, { max: 100 }).trim(),
            };
        }),
    };
}

function parseSource(body: any): PanelSource {
    if (body?.source === 'existing') {
        // Se acepta el ID o el enlace del mensaje (https://discord.com/channels/G/C/M); con el enlace no hace falta el canal.
        const raw = str(body?.messageId, 'messageId', { required: true, max: 200 }).trim();
        const link = /channels\/[^/]+\/([^/]+)\/(\d+)/.exec(raw);
        const messageId = link ? link[2] : raw;
        if (!SNOWFLAKE.test(messageId)) throw new HttpError(400, 'El ID del mensaje no es válido');
        const channelId = link ? link[1].slice(0, 32) : str(body?.channelId, 'channelId', { required: true, max: 32 });
        return { type: 'existing', channelId, messageId };
    }
    return { type: 'new', channelId: str(body?.channelId, 'channelId', { required: true, max: 32 }) };
}

export function createReactionsModule(service: ReactionRolesService): BotModule {
    const router = Router();
    const id = (v: unknown) => int(v, 'id', { min: 1 });

    router.get('/', (_req, res) => {
        res.json({ panels: service.list().map(p => ({ ...p, problems: service.roleProblems(p) })) });
    });

    router.get('/emojis', (_req, res) => res.json(service.customEmojis()));

    router.post('/', asyncRoute(async (req, res) => {
        res.status(201).json(await service.create(parsePanel(req.body), parseSource(req.body)));
    }));

    router.put('/:id', asyncRoute(async (req, res) => {
        res.json(await service.update(id(req.params.id), parsePanel(req.body)));
    }));

    router.post('/:id/enabled', (req, res) => {
        res.json(service.setEnabled(id(req.params.id), bool(req.body?.enabled)));
    });

    router.post('/:id/sync', asyncRoute(async (req, res) => {
        const panelId = id(req.params.id);
        res.json({ panel: service.require(panelId), warnings: await service.sync(panelId) });
    }));

    router.post('/:id/publish', asyncRoute(async (req, res) => {
        const channelId = str(req.body?.channelId, 'channelId', { required: true, max: 32 });
        res.json(await service.republish(id(req.params.id), channelId));
    }));

    router.delete('/:id', asyncRoute(async (req, res) => {
        await service.delete(id(req.params.id), bool(req.query.message));
        res.json({ ok: true });
    }));

    return {
        id: 'reactions',
        name: 'Roles por reacción',
        description: 'Mensajes en los que los miembros reaccionan para conseguir (o perder) roles. Cada reacción puede ser normal, permanente, quitar un rol, invertida o de pulsar; y el mensaje puede ser exclusivo (un solo rol a la vez).',
        router,
        start(ctx) {
            service.start();
            ctx.listen('messageReactionAdd', (reaction, user) => service.handle('add', reaction, user));
            ctx.listen('messageReactionRemove', (reaction, user) => service.handle('remove', reaction, user));
            ctx.onStop(() => service.stop());
        },
    };
}
