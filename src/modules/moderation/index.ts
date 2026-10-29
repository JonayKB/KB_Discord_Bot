import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str, strArray } from '../../core/http';
import type { BotModule } from '../../core/module';
import { ACTIONS, LOG_EVENTS, MAX_TIMEOUT_MS, type LogEvent, type ModAction, type ModerationConfig, type ModerationService } from './service';

export { ModerationService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SNOWFLAKE = /^\d{17,21}$/;

function parseConfig(body: any): ModerationConfig {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Configuración no válida');
    const log = Object.fromEntries(LOG_EVENTS.map(e => [e, body.log?.[e] === undefined ? true : bool(body.log[e])])) as Record<LogEvent, boolean>;
    return {
        logChannelId: str(body.logChannelId, 'logChannelId', { max: 32 }) || null,
        log,
        ignoreChannelIds: strArray(body.ignoreChannelIds, 'ignoreChannelIds', 100),
        dmOnAction: body.dmOnAction === undefined ? true : bool(body.dmOnAction),
    };
}

export function createModerationModule(service: ModerationService): BotModule {
    const router = Router();

    router.get('/config', (_req, res) => res.json(service.getConfig()));
    router.put('/config', (req, res) => res.json(service.setConfig(parseConfig(req.body))));

    router.get('/cases', (req, res) => {
        const action = req.query.action ? String(req.query.action) as ModAction : undefined;
        if (action && !ACTIONS.includes(action)) throw new HttpError(400, 'Acción no válida');
        res.json(service.cases({
            userId: req.query.userId ? String(req.query.userId) : undefined,
            action,
            before: req.query.before ? int(req.query.before, 'before', { min: 1 }) : undefined,
            limit: req.query.limit ? int(req.query.limit, 'limit', { min: 1, max: 500 }) : 100,
        }));
    });

    router.get('/users/:id', (req, res) => {
        const userId = String(req.params.id);
        res.json({ counts: service.countsFor(userId), cases: service.cases({ userId, limit: 200 }) });
    });

    router.delete('/cases/:id', (req, res) => {
        service.deleteCase(int(req.params.id, 'id', { min: 1 }));
        res.json({ ok: true });
    });

    router.get('/bans', asyncRoute(async (_req, res) => res.json(await service.bans())));

    router.post('/actions', asyncRoute(async (req, res) => {
        const b = req.body ?? {};
        const action = b.action as ModAction;
        if (!ACTIONS.includes(action)) throw new HttpError(400, 'Acción no válida');
        const userId = str(b.userId, 'userId', { required: true, max: 32 }).trim();
        if (!SNOWFLAKE.test(userId)) throw new HttpError(400, 'El ID de usuario no es válido');
        const c = await service.act({
            action,
            userId,
            reason: str(b.reason, 'reason', { max: 500 }),
            durationMs: action === 'timeout' ? int(b.durationMs, 'durationMs', { min: 60_000, max: MAX_TIMEOUT_MS }) : undefined,
            deleteDays: action === 'ban' && b.deleteDays !== undefined ? int(b.deleteDays, 'deleteDays', { min: 0, max: 7 }) : undefined,
            notify: b.notify === undefined ? undefined : bool(b.notify),
        }, { userId: req.session!.userId, username: req.session!.username });
        res.status(201).json(c);
    }));

    return {
        id: 'moderation',
        name: 'Moderación',
        description: 'Registro de auditoría en un canal (mensajes borrados y editados, entradas, salidas, roles, apodos, silencios y baneos) y acciones desde el panel (avisar, silenciar, expulsar, banear) con historial por usuario.',
        router,
        start(ctx) {
            service.active = true;
            ctx.listen('messageDelete', m => service.onMessageDelete(m));
            ctx.listen('messageUpdate', (a, b) => service.onMessageUpdate(a, b));
            ctx.listen('guildMemberAdd', m => service.onMemberJoin(m));
            ctx.listen('guildMemberRemove', m => service.onMemberLeave(m));
            ctx.listen('guildMemberUpdate', (a, b) => service.onMemberUpdate(a, b));
            ctx.listen('guildBanAdd', ban => service.onBan(ban, true));
            ctx.listen('guildBanRemove', ban => service.onBan(ban, false));
            ctx.onStop(() => { service.active = false; });
        },
    };
}
