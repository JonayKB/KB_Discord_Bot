import {
    ActionRowBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type Interaction,
} from 'discord.js';
import { Router } from 'express';
import { publish } from '../../core/bus';
import { HttpError, asyncRoute, bool, int, str, strArray } from '../../core/http';
import type { BotModule } from '../../core/module';
import { Logger } from '../../utils/Logger';
import type { Campaign, CampaignInput, ConfirmationService } from './service';

const logger = new Logger('ConfirmationsRoutes');

/* eslint-disable @typescript-eslint/no-explicit-any */

const HEX = /^#[0-9a-f]{6}$/i;
const optId = (v: unknown, field: string) => {
    const s = str(v, field, { max: 32 });
    return s || null;
};

function parseCampaign(body: any): CampaignInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos de campaña no válidos');
    const color = str(body.color, 'color', { max: 7 }) || '#3B82F6';
    if (!HEX.test(color)) throw new HttpError(400, 'El color debe ser hexadecimal, p. ej. #3B82F6');
    const nicknameTemplate = str(body.nicknameTemplate, 'nicknameTemplate', { max: 64 }) || '{global} ({answer})';
    return {
        name: str(body.name, 'name', { required: true, max: 80 }),
        enabled: body.enabled === undefined ? true : bool(body.enabled),
        title: str(body.title, 'title', { required: true, max: 256 }),
        description: str(body.description, 'description', { required: true, max: 4000 }),
        color,
        confirmLabel: str(body.confirmLabel, 'confirmLabel', { max: 80 }) || 'Abrir formulario',
        denyLabel: str(body.denyLabel, 'denyLabel', { max: 80 }) || 'No deseo participar',
        inputLabel: str(body.inputLabel, 'inputLabel', { max: 45 }) || 'Escribe tu nombre de usuario',
        allowDeny: body.allowDeny === undefined ? true : bool(body.allowDeny),
        confirmedRoleId: optId(body.confirmedRoleId, 'confirmedRoleId'),
        deniedRoleId: optId(body.deniedRoleId, 'deniedRoleId'),
        excludeRoleIds: strArray(body.excludeRoleIds, 'excludeRoleIds', 50),
        includeRoleIds: strArray(body.includeRoleIds, 'includeRoleIds', 50),
        inputLong: bool(body.inputLong),
        skipResponded: body.skipResponded === undefined ? true : bool(body.skipResponded),
        sendOnJoin: bool(body.sendOnJoin),
        setNickname: bool(body.setNickname),
        nicknameTemplate,
        counterTitle: str(body.counterTitle, 'counterTitle', { max: 256 }) || '📊 Cantidad de Personas QUE HAN CONFIRMADO:',
    };
}

/** customIds antiguos (de los MD ya enviados antes de esta versión) → acción equivalente. */
function parseCustomId(id: string, legacyId: number | null): { action: 'open' | 'deny' | 'modal' | 'dmodal'; campaignId: number } | null {
    const m = /^cf:(open|deny|modal|dmodal):(\d+)$/.exec(id);
    if (m) return { action: m[1] as 'open' | 'deny' | 'modal' | 'dmodal', campaignId: Number(m[2]) };
    if (legacyId === null) return null;
    switch (id) {
        case 'open_confirmation_modal': return { action: 'open', campaignId: legacyId };
        case 'open_denied_confirmation_modal': return { action: 'deny', campaignId: legacyId };
        case 'confirmation_modal': return { action: 'modal', campaignId: legacyId };
        case 'denied_confirmation_modal': return { action: 'dmodal', campaignId: legacyId };
        default: return null;
    }
}

export function createConfirmationsModule(service: ConfirmationService): BotModule {
    const router = Router();

    // ── Campañas ──
    router.get('/campaigns', (_req, res) => res.json(service.listCampaigns()));

    router.post('/campaigns', asyncRoute((req, res) => {
        res.status(201).json(service.createCampaign(parseCampaign(req.body)));
    }));

    router.get('/campaigns/:id', asyncRoute((req, res) => {
        res.json(service.requireCampaign(int(req.params.id, 'id', { min: 1 })));
    }));

    router.put('/campaigns/:id', asyncRoute((req, res) => {
        res.json(service.updateCampaign(int(req.params.id, 'id', { min: 1 }), parseCampaign(req.body)));
    }));

    router.delete('/campaigns/:id', asyncRoute((req, res) => {
        service.deleteCampaign(int(req.params.id, 'id', { min: 1 }));
        res.json({ ok: true });
    }));

    router.get('/campaigns/:id/stats', asyncRoute((req, res) => {
        res.json(service.stats(int(req.params.id, 'id', { min: 1 })));
    }));

    // ── Mensaje contador ──
    router.post('/campaigns/:id/counter', asyncRoute(async (req, res) => {
        const channelId = str(req.body?.channelId, 'channelId', { required: true, max: 32 });
        res.json(await service.createCounterMessage(int(req.params.id, 'id', { min: 1 }), channelId));
    }));

    router.post('/campaigns/:id/refresh', asyncRoute(async (req, res) => {
        await service.refreshCounter(int(req.params.id, 'id', { min: 1 }));
        res.json({ ok: true });
    }));

    // ── Confirmados ──
    router.get('/campaigns/:id/entries', asyncRoute((req, res) => {
        res.json(service.listEntries(int(req.params.id, 'id', { min: 1 })));
    }));

    router.post('/campaigns/:id/entries', asyncRoute(async (req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        const userId = str(req.body?.userId, 'userId', { required: true, max: 40 });
        const status = req.body?.status === 'denied' ? 'denied' : 'confirmed';
        const warnings = await service.respond(
            id, userId, status,
            { answer: str(req.body?.answer, 'answer', { max: 1000 }), reason: str(req.body?.reason, 'reason', { max: 1000 }) },
            { applyRoles: req.body?.applyRoles === undefined ? true : bool(req.body.applyRoles) }
        );
        res.status(201).json({ ok: true, warnings });
    }));

    router.post('/campaigns/:id/entries/delete', asyncRoute(async (req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        const userIds = strArray(req.body?.userIds, 'userIds', 2000);
        if (!userIds.length) throw new HttpError(400, 'No has seleccionado a nadie.');
        res.json(await service.removeEntries(id, userIds, {
            removeRole: req.body?.removeRole === undefined ? true : bool(req.body.removeRole),
            resetNickname: bool(req.body?.resetNickname),
        }));
    }));

    // ── Envío del formulario ──
    router.post('/campaigns/:id/send', asyncRoute((req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        const campaign = service.requireCampaign(id);
        const userIds = strArray(req.body?.userIds, 'userIds', 2000);
        const total = userIds.length || service.eligibleMembers(campaign).length;
        if (!total) throw new HttpError(400, 'No hay nadie pendiente a quien enviar.');
        void service.sendForm(id, userIds).catch(err => logger.error(`Error enviando la campaña ${id}`, err));
        res.status(202).json({ batchId: `campaign-${id}`, total });
    }));

    return {
        id: 'confirmations',
        name: 'Confirmaciones',
        description: 'Campañas de confirmación (varias a la vez): formulario por MD, roles, apodos, contador en un canal y gestión de confirmados.',
        router,

        start(ctx) {
            service.active = true;
            service.resolveLegacyEntries();
            service.scheduleRefresh();

            ctx.onStop(() => {
                service.active = false;
                service.cancelTimers();
            });

            const refresh = () => service.scheduleRefresh();
            ctx.listen('guildMemberRemove', refresh);
            ctx.listen('guildMemberUpdate', (oldM, newM) => {
                const changed = oldM.partial
                    || oldM.roles.cache.size !== newM.roles.cache.size
                    || oldM.roles.cache.some((_, id) => !newM.roles.cache.has(id));
                if (changed) refresh();
            });

            ctx.listen('guildMemberAdd', async member => {
                for (const c of service.listCampaigns()) {
                    if (!c.enabled || !c.sendOnJoin) continue;
                    // Con "solo a quien tenga estos roles", un recién llegado normalmente aún no los tiene.
                    if (!service.hasRequiredRole(c, member)) continue;
                    await service.sendForm(c.id, [member.id]).catch(err => ctx.logger.warn(`No se pudo enviar la confirmación "${c.name}" al nuevo miembro: ${err.message}`));
                }
                refresh();
            });

            ctx.listen('interactionCreate', async (interaction: Interaction) => {
                if (!interaction.isButton() && !interaction.isModalSubmit()) return;
                const legacyId = service.legacyCampaign()?.id ?? null;
                const parsed = parseCustomId(interaction.customId, legacyId);
                if (!parsed) return;

                const campaign: Campaign | null = service.getCampaign(parsed.campaignId);
                const gone = { content: 'Esta confirmación ya no está activa.', flags: MessageFlags.Ephemeral } as const;
                if (!campaign || !campaign.enabled) {
                    if (interaction.isRepliable()) await interaction.reply(gone);
                    return;
                }

                // Botón → abrir formulario
                if (interaction.isButton()) {
                    const isDeny = parsed.action === 'deny';
                    const input = new TextInputBuilder()
                        .setCustomId(isDeny ? 'reason' : 'answer')
                        .setLabel(isDeny ? 'Indica el motivo de tu no participación' : campaign.inputLabel.slice(0, 45))
                        .setStyle(isDeny || campaign.inputLong ? TextInputStyle.Paragraph : TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(isDeny || campaign.inputLong ? 1000 : 100);
                    const modal = new ModalBuilder()
                        .setCustomId(`cf:${isDeny ? 'dmodal' : 'modal'}:${campaign.id}`)
                        .setTitle(isDeny ? 'Confirmación de No Participación' : 'Formulario de confirmación')
                        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
                    await interaction.showModal(modal);
                    return;
                }

                // Modal enviado → guardar respuesta
                if (interaction.isModalSubmit()) {
                    const isDeny = parsed.action === 'dmodal';
                    const field = interaction.fields.fields.first();
                    const value = (field && 'value' in field && typeof field.value === 'string' ? field.value : '').trim();
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    ctx.logger.info(`📝 ${isDeny ? 'Denegación' : 'Confirmación'} de ${interaction.user.username} en "${campaign.name}": ${value}`);

                    const warnings = await service.respond(
                        campaign.id, interaction.user.id, isDeny ? 'denied' : 'confirmed',
                        isDeny ? { reason: value } : { answer: value }
                    );
                    if (warnings.length) publish('confirmations:warning', { campaignId: campaign.id, userId: interaction.user.id, warnings });
                    await interaction.editReply(isDeny ? '¡Recibido! Espero verte en otra ocasión. 😊' : '¡Recibido! Gracias por tu respuesta.');
                }
            });
        },
    };
}
