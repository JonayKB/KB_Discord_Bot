import { Router } from 'express';
import { HttpError, asyncRoute, bool, str, strArray } from '../../core/http';
import type { BotModule } from '../../core/module';
import { parsePayload } from '../messages/parse';
import type { WelcomeChannelMessage, WelcomeConfig, WelcomeKind, WelcomeService } from './service';

export { WelcomeService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const KINDS: WelcomeKind[] = ['dm', 'channel', 'goodbye'];

function parseChannelMessage(raw: any, field: string): WelcomeChannelMessage {
    return {
        enabled: bool(raw?.enabled),
        channelId: str(raw?.channelId, `${field}.channelId`, { max: 32 }) || null,
        payload: parsePayload(raw?.payload),
    };
}

function parseConfig(body: any): WelcomeConfig {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Configuración no válida');
    return {
        dm: { enabled: bool(body.dm?.enabled), payload: parsePayload(body.dm?.payload) },
        channel: parseChannelMessage(body.channel, 'channel'),
        goodbye: parseChannelMessage(body.goodbye, 'goodbye'),
        autoRoleIds: strArray(body.autoRoleIds, 'autoRoleIds', 20),
        ignoreBots: body.ignoreBots === undefined ? true : bool(body.ignoreBots),
    };
}

export function createWelcomeModule(service: WelcomeService): BotModule {
    const router = Router();

    router.get('/', (_req, res) => res.json(service.getConfig()));

    router.put('/', (req, res) => res.json(service.setConfig(parseConfig(req.body))));

    /** Prueba con la configuración que se está editando (sin guardarla). */
    router.post('/test', asyncRoute(async (req, res) => {
        const kind = req.body?.kind as WelcomeKind;
        if (!KINDS.includes(kind)) throw new HttpError(400, 'Tipo de mensaje no válido');
        const cfg = parseConfig(req.body?.config);
        if (kind !== 'dm' && !cfg[kind].channelId) throw new HttpError(400, 'Elige primero un canal.');
        res.json(await service.test(kind, cfg, req.session!.userId));
    }));

    return {
        id: 'welcome',
        name: 'Bienvenida',
        description: 'Da la bienvenida a los nuevos miembros por MD y/o en un canal, les pone roles automáticos y despide a quien se va. Los textos se editan desde el panel.',
        router,
        start(ctx) {
            service.active = true;
            ctx.listen('guildMemberAdd', member => service.onJoin(member));
            ctx.listen('guildMemberRemove', member => service.onLeave(member));
            ctx.onStop(() => { service.active = false; });
        },
    };
}
