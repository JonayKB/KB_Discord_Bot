import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    type Client,
    type Guild,
    type GuildMember,
} from 'discord.js';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { BotError, HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { BulkResult, MessagesService } from '../messages/service';

const logger = new Logger('ConfirmationsService');

export interface CampaignRow {
    id: number;
    name: string;
    enabled: number;
    title: string;
    description: string;
    color: string;
    confirm_label: string;
    deny_label: string;
    input_label: string;
    allow_deny: number;
    confirmed_role_id: string | null;
    denied_role_id: string | null;
    exclude_role_ids: string;
    include_role_ids: string;
    input_long: number;
    skip_responded: number;
    send_on_join: number;
    set_nickname: number;
    nickname_template: string;
    counter_title: string;
    counter_channel_id: string | null;
    counter_message_id: string | null;
    legacy: number;
    created_at: number;
}

export interface Campaign {
    id: number;
    name: string;
    enabled: boolean;
    title: string;
    description: string;
    color: string;
    confirmLabel: string;
    denyLabel: string;
    inputLabel: string;
    allowDeny: boolean;
    confirmedRoleId: string | null;
    deniedRoleId: string | null;
    excludeRoleIds: string[];
    /** Si no está vacío: solo se envía a quien tenga AL MENOS uno de estos roles. */
    includeRoleIds: string[];
    /** Respuesta de texto largo (párrafo, hasta 1000 caracteres) en vez de una línea. */
    inputLong: boolean;
    skipResponded: boolean;
    sendOnJoin: boolean;
    setNickname: boolean;
    nicknameTemplate: string;
    counterTitle: string;
    counterChannelId: string | null;
    counterMessageId: string | null;
    legacy: boolean;
    createdAt: number;
}

export type CampaignInput = Omit<Campaign, 'id' | 'legacy' | 'createdAt' | 'counterChannelId' | 'counterMessageId'>;

export interface EntryRow {
    id: number;
    campaign_id: number;
    user_id: string;
    username: string | null;
    display_name: string | null;
    answer: string | null;
    status: 'confirmed' | 'denied';
    reason: string | null;
    created_at: number;
    updated_at: number;
}

export interface Entry {
    id: number;
    campaignId: number;
    userId: string;
    username: string | null;
    displayName: string | null;
    answer: string | null;
    status: 'confirmed' | 'denied';
    reason: string | null;
    createdAt: number;
    updatedAt: number;
    inGuild: boolean;
    hasRole: boolean;
    unresolved: boolean;
}

export const toCampaign = (r: CampaignRow): Campaign => ({
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    title: r.title,
    description: r.description,
    color: r.color,
    confirmLabel: r.confirm_label,
    denyLabel: r.deny_label,
    inputLabel: r.input_label,
    allowDeny: !!r.allow_deny,
    confirmedRoleId: r.confirmed_role_id,
    deniedRoleId: r.denied_role_id,
    excludeRoleIds: parseJson<string[]>(r.exclude_role_ids, []),
    includeRoleIds: parseJson<string[]>(r.include_role_ids, []),
    inputLong: !!r.input_long,
    skipResponded: !!r.skip_responded,
    sendOnJoin: !!r.send_on_join,
    setNickname: !!r.set_nickname,
    nicknameTemplate: r.nickname_template,
    counterTitle: r.counter_title,
    counterChannelId: r.counter_channel_id,
    counterMessageId: r.counter_message_id,
    legacy: !!r.legacy,
    createdAt: r.created_at,
});

/**
 * Otros módulos (p. ej. la whitelist de los servidores) pueden validar y reaccionar a las respuestas.
 */
export interface ConfirmationHooks {
    /** Antes de guardar una confirmación. Devuelve `error` para rechazarla o `answer` para corregirla (p. ej. mayúsculas). */
    validate?(campaignId: number, userId: string, answer: string, opts: { fromPanel: boolean }): Promise<{ error?: string; answer?: string }>;
    /** Después de guardar una confirmación. Lo devuelto se le muestra al usuario. */
    confirmed?(campaignId: number, userId: string, answer: string, opts: { fromPanel: boolean }): Promise<string[]>;
    /** El usuario deja de estar confirmado (no participa o se le borra). */
    removed?(campaignId: number, userId: string, reason: string): Promise<void>;
}

export class ConfirmationService {
    private refreshTimers = new Map<number, NodeJS.Timeout>();
    private readonly hooks: ConfirmationHooks[] = [];
    /** Solo true mientras el módulo está activo. */
    active = false;

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly messages: MessagesService
    ) {}

    addHooks(h: ConfirmationHooks): void {
        this.hooks.push(h);
    }

    guild(): Guild | undefined {
        return this.client.guilds.cache.get(env.guildId);
    }

    // ────────────────────────── Campañas (CRUD) ──────────────────────────

    listCampaigns(): Campaign[] {
        return (this.db.prepare('SELECT * FROM campaigns ORDER BY id').all() as CampaignRow[]).map(toCampaign);
    }

    getCampaign(id: number): Campaign | null {
        const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
        return row ? toCampaign(row) : null;
    }

    requireCampaign(id: number): Campaign {
        const c = this.getCampaign(id);
        if (!c) throw new HttpError(404, 'Campaña no encontrada');
        return c;
    }

    legacyCampaign(): Campaign | null {
        const row = this.db.prepare('SELECT * FROM campaigns WHERE legacy = 1 ORDER BY id LIMIT 1').get() as CampaignRow | undefined;
        return row ? toCampaign(row) : null;
    }

    createCampaign(input: CampaignInput): Campaign {
        const res = this.db.prepare(`
            INSERT INTO campaigns (name, enabled, title, description, color, confirm_label, deny_label, input_label, allow_deny,
                confirmed_role_id, denied_role_id, exclude_role_ids, include_role_ids, input_long, skip_responded, send_on_join, set_nickname,
                nickname_template, counter_title, created_at)
            VALUES (@name, @enabled, @title, @description, @color, @confirmLabel, @denyLabel, @inputLabel, @allowDeny,
                @confirmedRoleId, @deniedRoleId, @excludeRoleIds, @includeRoleIds, @inputLong, @skipResponded, @sendOnJoin, @setNickname,
                @nicknameTemplate, @counterTitle, @createdAt)
        `).run(this.toParams(input, { createdAt: Date.now() }));
        const c = this.requireCampaign(Number(res.lastInsertRowid));
        publish('campaign:updated', c);
        return c;
    }

    updateCampaign(id: number, input: CampaignInput): Campaign {
        this.requireCampaign(id);
        this.db.prepare(`
            UPDATE campaigns SET name=@name, enabled=@enabled, title=@title, description=@description, color=@color,
                confirm_label=@confirmLabel, deny_label=@denyLabel, input_label=@inputLabel, allow_deny=@allowDeny,
                confirmed_role_id=@confirmedRoleId, denied_role_id=@deniedRoleId, exclude_role_ids=@excludeRoleIds,
                include_role_ids=@includeRoleIds, input_long=@inputLong,
                skip_responded=@skipResponded, send_on_join=@sendOnJoin, set_nickname=@setNickname,
                nickname_template=@nicknameTemplate, counter_title=@counterTitle
            WHERE id=@id
        `).run(this.toParams(input, { id }));
        const c = this.requireCampaign(id);
        publish('campaign:updated', c);
        this.scheduleRefresh(id);
        return c;
    }

    deleteCampaign(id: number): void {
        const used = this.db.prepare("SELECT name FROM jobs WHERE action_type = 'send_campaign' AND json_extract(action_json, '$.campaignId') = ?").get(id) as { name: string } | undefined;
        if (used) throw new HttpError(409, `La programación "${used.name}" usa esta campaña. Elimínala primero.`);
        const res = this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
        if (!res.changes) throw new HttpError(404, 'Campaña no encontrada');
        publish('campaign:deleted', { id });
    }

    private toParams(i: CampaignInput, extra: Record<string, unknown>) {
        return {
            name: i.name,
            enabled: i.enabled ? 1 : 0,
            title: i.title,
            description: i.description,
            color: i.color,
            confirmLabel: i.confirmLabel,
            denyLabel: i.denyLabel,
            inputLabel: i.inputLabel,
            allowDeny: i.allowDeny ? 1 : 0,
            confirmedRoleId: i.confirmedRoleId || null,
            deniedRoleId: i.deniedRoleId || null,
            excludeRoleIds: JSON.stringify(i.excludeRoleIds),
            includeRoleIds: JSON.stringify(i.includeRoleIds),
            inputLong: i.inputLong ? 1 : 0,
            skipResponded: i.skipResponded ? 1 : 0,
            sendOnJoin: i.sendOnJoin ? 1 : 0,
            setNickname: i.setNickname ? 1 : 0,
            nicknameTemplate: i.nicknameTemplate,
            counterTitle: i.counterTitle,
            ...extra,
        };
    }

    // ────────────────────────── Confirmados ──────────────────────────

    listEntries(campaignId: number): Entry[] {
        const campaign = this.requireCampaign(campaignId);
        const guild = this.guild();
        const rows = this.db.prepare('SELECT * FROM confirmations WHERE campaign_id = ? ORDER BY updated_at DESC').all(campaignId) as EntryRow[];
        return rows.map(r => {
            const member = guild?.members.cache.get(r.user_id);
            return {
                id: r.id,
                campaignId: r.campaign_id,
                userId: r.user_id,
                username: r.username,
                displayName: member?.displayName ?? r.display_name,
                answer: r.answer,
                status: r.status,
                reason: r.reason,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                inGuild: !!member,
                hasRole: !!(member && campaign.confirmedRoleId && member.roles.cache.has(campaign.confirmedRoleId)),
                unresolved: r.user_id.startsWith('legacy:'),
            };
        });
    }

    stats(campaignId: number) {
        const campaign = this.requireCampaign(campaignId);
        const count = (status: string) =>
            (this.db.prepare('SELECT COUNT(*) AS n FROM confirmations WHERE campaign_id = ? AND status = ?').get(campaignId, status) as { n: number }).n;
        return {
            confirmed: count('confirmed'),
            denied: count('denied'),
            pending: this.eligibleMembers(campaign).length,
            members: this.guild()?.memberCount ?? 0,
            roleMembers: campaign.confirmedRoleId ? (this.guild()?.roles.cache.get(campaign.confirmedRoleId)?.members.size ?? 0) : 0,
        };
    }

    getEntry(campaignId: number, userId: string): EntryRow | undefined {
        return this.db.prepare('SELECT * FROM confirmations WHERE campaign_id = ? AND user_id = ?').get(campaignId, userId) as EntryRow | undefined;
    }

    upsertEntry(campaignId: number, e: { userId: string; username?: string | null; displayName?: string | null; answer?: string | null; status: 'confirmed' | 'denied'; reason?: string | null }): void {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO confirmations (campaign_id, user_id, username, display_name, answer, status, reason, created_at, updated_at)
            VALUES (@campaignId, @userId, @username, @displayName, @answer, @status, @reason, @now, @now)
            ON CONFLICT (campaign_id, user_id) DO UPDATE SET
                username = COALESCE(excluded.username, username),
                display_name = COALESCE(excluded.display_name, display_name),
                answer = excluded.answer, status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at
        `).run({
            campaignId, userId: e.userId, username: e.username ?? null, displayName: e.displayName ?? null,
            answer: e.answer ?? null, status: e.status, reason: e.reason ?? null, now,
        });
        publish('confirmations:changed', { campaignId });
    }

    /**
     * Registra la respuesta de un usuario (confirmar / no participar) y aplica roles y apodo.
     * Se usa tanto cuando el usuario rellena el formulario como cuando lo añades a mano desde el panel.
     */
    async respond(
        campaignId: number,
        userId: string,
        status: 'confirmed' | 'denied',
        data: { answer?: string; reason?: string },
        opts: { applyRoles?: boolean; fromPanel?: boolean; notes?: string[] } = {}
    ): Promise<string[]> {
        const campaign = this.requireCampaign(campaignId);
        const guild = this.guild();
        const warnings: string[] = [];
        const applyRoles = opts.applyRoles ?? true;
        const fromPanel = opts.fromPanel ?? false;

        // Los módulos enganchados pueden rechazar o corregir la respuesta ANTES de guardar nada.
        if (status === 'confirmed' && data.answer) {
            let answer = data.answer;
            for (const h of this.hooks) {
                const r = await h.validate?.(campaignId, userId, answer, { fromPanel });
                if (r?.error) throw new BotError(r.error);
                if (r?.answer) answer = r.answer;
            }
            data = { ...data, answer };
        }

        const member = guild ? (guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => undefined)) : undefined;
        const user = member?.user ?? await this.client.users.fetch(userId).catch(() => undefined);

        // Si el usuario cambia de opinión, se elimina la entrada duplicada antigua del importador (legacy:usuario).
        if (user) this.db.prepare('DELETE FROM confirmations WHERE campaign_id = ? AND user_id = ?').run(campaignId, `legacy:${user.username}`);

        this.upsertEntry(campaignId, {
            userId,
            username: user?.username ?? null,
            displayName: member?.displayName ?? user?.globalName ?? user?.username ?? null,
            answer: status === 'confirmed' ? (data.answer ?? null) : null,
            status,
            reason: status === 'denied' ? (data.reason ?? null) : null,
        });

        if (member && applyRoles) {
            const add = status === 'confirmed' ? campaign.confirmedRoleId : campaign.deniedRoleId;
            const remove = status === 'confirmed' ? campaign.deniedRoleId : campaign.confirmedRoleId;
            try {
                if (add && add !== remove && !member.roles.cache.has(add)) await member.roles.add(add);
                if (remove && remove !== add && member.roles.cache.has(remove)) await member.roles.remove(remove);
            } catch (err) {
                warnings.push(`Roles: ${(err as Error).message}`);
                logger.error(`No se pudieron actualizar los roles de ${member.user.username}`, err);
            }

            if (status === 'confirmed' && campaign.setNickname && data.answer) {
                const nick = campaign.nicknameTemplate
                    .replaceAll('{global}', user?.globalName ?? user?.username ?? '')
                    .replaceAll('{username}', user?.username ?? '')
                    .replaceAll('{answer}', data.answer)
                    .slice(0, 32);
                try {
                    if (!member.manageable) throw new Error('no tengo jerarquía suficiente sobre este usuario');
                    await member.setNickname(nick);
                } catch (err) {
                    warnings.push(`Apodo: ${(err as Error).message}`);
                    logger.warn(`No se pudo cambiar el apodo de ${member.user.username}: ${(err as Error).message}`);
                }
            }
        } else if (!member) {
            warnings.push('El usuario no está en el servidor: solo se guardó la respuesta.');
        }

        for (const h of this.hooks) {
            try {
                if (status === 'confirmed' && data.answer) opts.notes?.push(...(await h.confirmed?.(campaignId, userId, data.answer, { fromPanel }) ?? []));
                else await h.removed?.(campaignId, userId, 'Ha indicado que no participa');
            } catch (err) {
                warnings.push((err as Error).message);
                logger.error('Error en un módulo enganchado a las confirmaciones', err);
            }
        }

        this.scheduleRefresh(campaignId);
        return warnings;
    }

    /**
     * Borra confirmados. Opcionalmente quita el rol y restablece el apodo.
     * Devuelve cuántos se borraron y los fallos al tocar roles/apodos.
     */
    async removeEntries(campaignId: number, userIds: string[], opts: { removeRole: boolean; resetNickname: boolean }) {
        const campaign = this.requireCampaign(campaignId);
        const guild = this.guild();
        const warnings: string[] = [];
        let removed = 0;

        for (const userId of userIds) {
            const entry = this.getEntry(campaignId, userId);
            if (!entry) continue;

            if (guild && !userId.startsWith('legacy:')) {
                const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => undefined);
                if (member) {
                    try {
                        if (opts.removeRole) {
                            const roles = [campaign.confirmedRoleId, campaign.deniedRoleId].filter((r): r is string => !!r && member.roles.cache.has(r));
                            if (roles.length) await member.roles.remove(roles);
                        }
                        if (opts.resetNickname && member.manageable && member.nickname) await member.setNickname(null);
                    } catch (err) {
                        warnings.push(`${member.user.username}: ${(err as Error).message}`);
                    }
                }
            }
            this.db.prepare('DELETE FROM confirmations WHERE campaign_id = ? AND user_id = ?').run(campaignId, userId);
            removed++;
            for (const h of this.hooks) await h.removed?.(campaignId, userId, 'Borrado de la campaña').catch(err => warnings.push((err as Error).message));
        }
        publish('confirmations:changed', { campaignId });
        this.scheduleRefresh(campaignId);
        return { removed, warnings };
    }

    /** Busca el usuario de Discord asociado a un nombre de Minecraft (usado por el mensaje de estado del servidor). */
    usernameForAnswer(answer: string): string | null {
        const row = this.db.prepare(
            "SELECT username FROM confirmations WHERE status = 'confirmed' AND lower(answer) = lower(?) AND username IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
        ).get(answer) as { username: string } | undefined;
        return row?.username ?? null;
    }

    /** Intenta asociar entradas importadas (solo con nombre de usuario) a su ID real de Discord. */
    resolveLegacyEntries(): number {
        const guild = this.guild();
        if (!guild) return 0;
        const rows = this.db.prepare("SELECT id, campaign_id, user_id, username FROM confirmations WHERE user_id LIKE 'legacy:%'").all() as Array<{ id: number; campaign_id: number; user_id: string; username: string }>;
        let n = 0;
        for (const r of rows) {
            const member = guild.members.cache.find(m => m.user.username === r.username);
            if (!member) continue;
            const exists = this.getEntry(r.campaign_id, member.id);
            if (exists) {
                this.db.prepare('DELETE FROM confirmations WHERE id = ?').run(r.id);
            } else {
                this.db.prepare('UPDATE confirmations SET user_id = ?, display_name = ? WHERE id = ?').run(member.id, member.displayName, r.id);
            }
            n++;
        }
        return n;
    }

    // ────────────────────────── Envío del formulario ──────────────────────────

    /** ¿Cumple el miembro el filtro "solo a quien tenga alguno de estos roles"? (sin filtro → sí) */
    hasRequiredRole(campaign: Campaign, member: GuildMember): boolean {
        return !campaign.includeRoleIds.length || campaign.includeRoleIds.some(r => member.roles.cache.has(r));
    }

    eligibleMembers(campaign: Campaign): GuildMember[] {
        const guild = this.guild();
        if (!guild) return [];
        const responded = new Set(
            (this.db.prepare('SELECT user_id FROM confirmations WHERE campaign_id = ?').all(campaign.id) as Array<{ user_id: string }>).map(r => r.user_id)
        );
        const exclude = new Set(campaign.excludeRoleIds);
        return [...guild.members.cache.values()].filter(m => {
            if (m.user.bot) return false;
            if (!this.hasRequiredRole(campaign, m)) return false;
            if ([...exclude].some(r => m.roles.cache.has(r))) return false;
            if (campaign.skipResponded) {
                if (responded.has(m.id)) return false;
                if (campaign.confirmedRoleId && m.roles.cache.has(campaign.confirmedRoleId)) return false;
                if (campaign.deniedRoleId && m.roles.cache.has(campaign.deniedRoleId)) return false;
            }
            return true;
        });
    }

    formPayload(campaign: Campaign) {
        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`cf:open:${campaign.id}`).setLabel(campaign.confirmLabel).setEmoji('📝').setStyle(ButtonStyle.Secondary)
        );
        if (campaign.allowDeny) {
            buttons.addComponents(
                new ButtonBuilder().setCustomId(`cf:deny:${campaign.id}`).setLabel(campaign.denyLabel).setEmoji('❌').setStyle(ButtonStyle.Danger)
            );
        }
        return {
            payload: {
                embed: { title: campaign.title, description: campaign.description, color: campaign.color, footer: 'Sistema automático de confirmación', timestamp: true },
            },
            components: [buttons],
        };
    }

    /** Envía el formulario a los pendientes (o a usuarios concretos, ignorando filtros). */
    async sendForm(campaignId: number, userIds?: string[]): Promise<BulkResult> {
        const campaign = this.requireCampaign(campaignId);
        if (!campaign.enabled) throw new BotError(`La campaña "${campaign.name}" está desactivada.`);
        const ids = userIds?.length ? userIds : this.eligibleMembers(campaign).map(m => m.id);
        const { payload, components } = this.formPayload(campaign);
        logger.info(`📩 Enviando formulario "${campaign.name}" a ${ids.length} usuarios`);

        if (ids.length === 1) {
            const rec = await this.messages.sendToUser(ids[0], payload, { source: 'campaign', sourceRef: String(campaign.id) }, { components });
            const failed = rec.status === 'sent' ? 0 : 1;
            publish('bulk:progress', { batchId: `campaign-${campaign.id}`, total: 1, done: 1, failed, finished: true });
            return { total: 1, sent: 1 - failed, failed };
        }
        return this.sendFormBulk(campaign, ids, payload, components);
    }

    private async sendFormBulk(campaign: Campaign, ids: string[], payload: ReturnType<ConfirmationService['formPayload']>['payload'], components: ReturnType<ConfirmationService['formPayload']>['components']): Promise<BulkResult> {
        // El envío masivo normal no admite botones, así que enviamos uno a uno con la misma cadencia.
        const result: BulkResult = { total: ids.length, sent: 0, failed: 0 };
        for (let i = 0; i < ids.length; i++) {
            const rec = await this.messages.sendToUser(ids[i], payload, { source: 'campaign', sourceRef: String(campaign.id) }, { components }).catch(err => {
                if (err instanceof BotError) throw err;
                return null;
            });
            if (rec?.status === 'sent') result.sent++; else result.failed++;
            publish('bulk:progress', { batchId: `campaign-${campaign.id}`, total: ids.length, done: i + 1, failed: result.failed, finished: i + 1 === ids.length });
            if (i + 1 < ids.length) await new Promise(r => setTimeout(r, 1100));
        }
        return result;
    }

    // ────────────────────────── Mensaje contador ──────────────────────────

    async createCounterMessage(campaignId: number, channelId: string): Promise<Campaign> {
        const campaign = this.requireCampaign(campaignId);
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('send' in channel)) throw new HttpError(400, 'Ese canal no admite mensajes.');
        const embed = new EmbedBuilder()
            .setTitle(campaign.counterTitle)
            .setDescription('**ESPERANDO ACTUALIZACIÓN...**')
            .setColor(0x0000ff)
            .setTimestamp();
        const sent = await (channel as { send: (o: unknown) => Promise<{ id: string }> }).send({ embeds: [embed] });
        this.db.prepare('UPDATE campaigns SET counter_channel_id = ?, counter_message_id = ? WHERE id = ?').run(channelId, sent.id, campaignId);
        await this.refreshCounter(campaignId);
        const updated = this.requireCampaign(campaignId);
        publish('campaign:updated', updated);
        return updated;
    }

    /** Programa una actualización del contador (agrupa varias peticiones seguidas en una sola). */
    scheduleRefresh(campaignId?: number): void {
        if (!this.active) return;
        const ids = campaignId ? [campaignId] : this.listCampaigns().filter(c => c.counterMessageId).map(c => c.id);
        for (const id of ids) {
            if (this.refreshTimers.has(id)) continue;
            this.refreshTimers.set(id, setTimeout(() => {
                this.refreshTimers.delete(id);
                this.refreshCounter(id).catch(err => logger.error(`No se pudo actualizar el contador de la campaña ${id}`, err));
            }, 2000));
        }
    }

    cancelTimers(): void {
        for (const t of this.refreshTimers.values()) clearTimeout(t);
        this.refreshTimers.clear();
    }

    async refreshCounter(campaignId: number): Promise<void> {
        const campaign = this.getCampaign(campaignId);
        if (!campaign?.counterChannelId || !campaign.counterMessageId || !campaign.confirmedRoleId) return;
        const guild = this.guild();
        const role = guild?.roles.cache.get(campaign.confirmedRoleId);
        if (!guild || !role) {
            logger.warn(`Contador "${campaign.name}": rol o servidor no encontrado.`);
            return;
        }
        const channel = await guild.channels.fetch(campaign.counterChannelId).catch(() => null);
        if (!channel || !('messages' in channel)) {
            logger.warn(`Contador "${campaign.name}": canal no encontrado.`);
            return;
        }
        const message = await channel.messages.fetch(campaign.counterMessageId).catch(() => null);
        if (!message) {
            logger.warn(`Contador "${campaign.name}": el mensaje ya no existe. Vuelve a crearlo desde el panel.`);
            return;
        }

        const names = role.members.map(m => m.user.globalName ?? m.user.username).sort((a, b) => a.localeCompare(b));
        let list = '';
        let shown = 0;
        for (const n of names) {
            if (list.length + n.length + 1 > 3500) break;
            list += `${n}\n`;
            shown++;
        }
        if (shown < names.length) list += `*…y ${names.length - shown} más*`;

        const embed = new EmbedBuilder()
            .setTitle(campaign.counterTitle)
            .setDescription(`**Total de personas que han confirmado:** ${names.length}\n\n${list || '*Nadie ha confirmado aún*'}`)
            .setColor(0x27f720)
            .setFooter({ text: `Actualizado automáticamente para ${guild.memberCount} personas` })
            .setTimestamp();
        await message.edit({ embeds: [embed] });
    }
}
