import { Router } from 'express';
import { HttpError, bool, int, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import type { GroupConfig, VerificationConfig, VerificationService } from './service';

export { VerificationService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHECK_EVERY_MS = 5 * 60_000;

function parseGroup(raw: any, field: string): GroupConfig {
    const message = str(raw?.message, `${field}.message`, { required: true, max: 1500 }).trim();
    const reason = str(raw?.reason, `${field}.reason`, { required: true, max: 400 }).trim();
    if (!message || !reason) throw new HttpError(400, 'El mensaje y el motivo no pueden estar vacíos.');
    return { days: int(raw?.days, `${field}.days`, { min: 1, max: 60 }), message, reason };
}

function parseConfig(body: any): VerificationConfig {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Configuración no válida');
    const id = (field: string) => str(body[field], field, { max: 32 }) || null;
    return {
        enabled: bool(body.enabled),
        unverifiedRoleId: id('unverifiedRoleId'),
        confirmedRoleId: id('confirmedRoleId'),
        verifiedRoleId: id('verifiedRoleId'),
        rulesChannelId: id('rulesChannelId'),
        fallbackChannelId: id('fallbackChannelId'),
        groups: {
            unverified: parseGroup(body.groups?.unverified, 'unverified'),
            confirmed: parseGroup(body.groups?.confirmed, 'confirmed'),
        },
    };
}

export function createVerificationModule(service: VerificationService): BotModule {
    const router = Router();

    router.get('/', (_req, res) => res.json(service.getConfig()));
    router.put('/', (req, res) => res.json(service.setConfig(parseConfig(req.body))));
    router.get('/status', (_req, res) => res.json(service.status()));

    return {
        id: 'verification',
        name: 'Verificación',
        description: 'Avisa a diario a quien no se ha verificado y lo expulsa al acabar su plazo, con un plazo mayor si ya confirmó. No hace nada hasta que se configura y se activa en su sección.',
        router,
        start(ctx) {
            service.active = true;
            ctx.listen('guildMemberUpdate', (_before, after) => service.onMemberUpdate(after));
            ctx.listen('guildMemberRemove', member => service.forget(member.id));
            ctx.every(CHECK_EVERY_MS, () => service.run());
            ctx.onStop(() => service.stop());
        },
    };
}
