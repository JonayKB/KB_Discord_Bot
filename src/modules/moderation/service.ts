import {
    EmbedBuilder,
    type Client,
    type Guild,
    type GuildBan,
    type GuildMember,
    type Message,
    type PartialGuildMember,
    type PartialMessage,
} from 'discord.js';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { MessagesService } from '../messages/service';

const logger = new Logger('Moderation');
const KEY = 'moderation.config';

export const ACTIONS = ['warn', 'note', 'timeout', 'untimeout', 'kick', 'ban', 'unban'] as const;
export type ModAction = typeof ACTIONS[number];

export const LOG_EVENTS = ['messageDelete', 'messageEdit', 'memberJoin', 'memberLeave', 'roles', 'nicknames', 'timeouts', 'bans', 'modActions'] as const;
export type LogEvent = typeof LOG_EVENTS[number];

export interface ModerationConfig {
    /** Canal donde se publica el registro (vacío = no se publica nada). */
    logChannelId: string | null;
    log: Record<LogEvent, boolean>;
    /** Canales cuyos mensajes borrados/editados no se registran. */
    ignoreChannelIds: string[];
    /** Avisar por MD al usuario cuando se le sanciona. */
    dmOnAction: boolean;
}

const DEFAULT_CONFIG: ModerationConfig = {
    logChannelId: null,
    log: { messageDelete: true, messageEdit: true, memberJoin: true, memberLeave: true, roles: true, nicknames: true, timeouts: true, bans: true, modActions: true },
    ignoreChannelIds: [],
    dmOnAction: true,
};

interface CaseRow {
    id: number;
    user_id: string;
    user_tag: string | null;
    action: ModAction;
    reason: string | null;
    duration_ms: number | null;
    moderator_id: string | null;
    moderator_name: string | null;
    source: 'panel' | 'discord';
    dm_status: 'sent' | 'failed' | null;
    created_at: number;
}

export interface ModCase {
    id: number;
    userId: string;
    userTag: string | null;
    action: ModAction;
    reason: string | null;
    durationMs: number | null;
    moderatorId: string | null;
    moderatorName: string | null;
    source: 'panel' | 'discord';
    dmStatus: 'sent' | 'failed' | null;
    createdAt: number;
}

const toCase = (r: CaseRow): ModCase => ({
    id: r.id,
    userId: r.user_id,
    userTag: r.user_tag,
    action: r.action,
    reason: r.reason,
    durationMs: r.duration_ms,
    moderatorId: r.moderator_id,
    moderatorName: r.moderator_name,
    source: r.source,
    dmStatus: r.dm_status,
    createdAt: r.created_at,
});

export interface ActionInput {
    action: ModAction;
    userId: string;
    reason: string;
    /** Solo para timeout. */
    durationMs?: number;
    /** Solo para ban: borrar sus mensajes de los últimos N días (0-7). */
    deleteDays?: number;
    /** Por defecto, lo que diga la configuración. */
    notify?: boolean;
}

export interface Moderator { userId: string; username: string }

const LABEL: Record<ModAction, string> = {
    warn: 'Aviso', note: 'Nota', timeout: 'Silencio', untimeout: 'Fin del silencio', kick: 'Expulsión', ban: 'Baneo', unban: 'Desbaneo',
};
const COLOR: Record<ModAction, number> = {
    warn: 0xe8a317, note: 0x8f98a9, timeout: 0xe67e22, untimeout: 0x3ba55d, kick: 0xed4245, ban: 0x992d22, unban: 0x3ba55d,
};
const DM_TEXT: Partial<Record<ModAction, string>> = {
    warn: '⚠️ Has recibido un aviso en **{server}**',
    timeout: '🔇 Te han silenciado en **{server}**',
    kick: '👢 Te han expulsado de **{server}**',
    ban: '⛔ Te han baneado de **{server}**',
};

export const MAX_TIMEOUT_MS = 28 * 24 * 3600_000;

export function fmtDuration(ms: number): string {
    const min = Math.round(ms / 60_000);
    if (min < 60) return `${min} min`;
    if (min < 1440) return `${Math.round(min / 60 * 10) / 10} h`;
    return `${Math.round(min / 1440 * 10) / 10} días`;
}

const clip = (s: string, n = 1000) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class ModerationService {
    active = false;
    /** Acciones hechas desde el panel: su evento de Discord no se registra dos veces. */
    private readonly recent = new Set<string>();

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly messages: MessagesService
    ) {}

    private guild(): Guild {
        const g = this.client.guilds.cache.get(env.guildId);
        if (!g) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
        return g;
    }

    // ────────────────────────── Configuración ──────────────────────────

    getConfig(): ModerationConfig {
        const saved = parseJson<Partial<ModerationConfig>>(getSetting(this.db, KEY, ''), {});
        return {
            logChannelId: saved.logChannelId ?? DEFAULT_CONFIG.logChannelId,
            log: { ...DEFAULT_CONFIG.log, ...saved.log },
            ignoreChannelIds: saved.ignoreChannelIds ?? DEFAULT_CONFIG.ignoreChannelIds,
            dmOnAction: saved.dmOnAction ?? DEFAULT_CONFIG.dmOnAction,
        };
    }

    setConfig(cfg: ModerationConfig): ModerationConfig {
        setSetting(this.db, KEY, JSON.stringify(cfg));
        publish('moderation:changed', {});
        return this.getConfig();
    }

    // ────────────────────────── Casos ──────────────────────────

    cases(q: { userId?: string; action?: ModAction; before?: number; limit?: number } = {}): ModCase[] {
        const where: string[] = [];
        const params: Record<string, unknown> = { limit: Math.min(q.limit ?? 100, 500) };
        if (q.userId) { where.push('user_id = @userId'); params.userId = q.userId; }
        if (q.action) { where.push('action = @action'); params.action = q.action; }
        if (q.before) { where.push('id < @before'); params.before = q.before; }
        const sql = `SELECT * FROM mod_cases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`;
        return (this.db.prepare(sql).all(params) as CaseRow[]).map(toCase);
    }

    /** Cuántas sanciones de cada tipo tiene un usuario. */
    countsFor(userId: string): Partial<Record<ModAction, number>> {
        const rows = this.db.prepare('SELECT action, COUNT(*) AS n FROM mod_cases WHERE user_id = ? GROUP BY action').all(userId) as Array<{ action: ModAction; n: number }>;
        return Object.fromEntries(rows.map(r => [r.action, r.n]));
    }

    deleteCase(id: number): void {
        const res = this.db.prepare('DELETE FROM mod_cases WHERE id = ?').run(id);
        if (!res.changes) throw new HttpError(404, 'Caso no encontrado');
        publish('moderation:cases', { id });
    }

    private addCase(c: Omit<ModCase, 'id' | 'createdAt'>): ModCase {
        const res = this.db.prepare(`
            INSERT INTO mod_cases (user_id, user_tag, action, reason, duration_ms, moderator_id, moderator_name, source, dm_status, created_at)
            VALUES (@userId, @userTag, @action, @reason, @durationMs, @moderatorId, @moderatorName, @source, @dmStatus, @createdAt)
        `).run({ ...c, createdAt: Date.now() });
        const row = this.db.prepare('SELECT * FROM mod_cases WHERE id = ?').get(res.lastInsertRowid) as CaseRow;
        const out = toCase(row);
        publish('moderation:cases', out);
        return out;
    }

    private markRecent(action: string, userId: string): void {
        const key = `${action}:${userId}`;
        this.recent.add(key);
        setTimeout(() => this.recent.delete(key), 15_000).unref?.();
    }

    // ────────────────────────── Acciones ──────────────────────────

    async act(input: ActionInput, mod: Moderator): Promise<ModCase> {
        const guild = this.guild();
        const reason = input.reason.trim();
        if (!reason && input.action !== 'untimeout' && input.action !== 'unban') throw new HttpError(400, 'Escribe un motivo.');
        const auditReason = `${reason || LABEL[input.action]} · por ${mod.username} (panel)`.slice(0, 500);

        const member = await guild.members.fetch(input.userId).catch(() => null);
        const user = member?.user ?? await this.client.users.fetch(input.userId).catch(() => null);
        if (!user) throw new HttpError(404, 'No existe ningún usuario de Discord con ese ID.');
        if (user.id === this.client.user?.id) throw new HttpError(400, 'No puedes sancionar al propio bot.');

        // Comprobaciones antes de avisar por MD (para no avisar de algo que luego falla).
        switch (input.action) {
            case 'timeout':
            case 'untimeout':
                if (!member) throw new HttpError(400, 'El usuario no está en el servidor.');
                if (!member.moderatable) throw new HttpError(400, 'El bot no puede silenciar a este usuario (tiene un rol igual o superior, o falta el permiso "Aislar temporalmente").');
                if (input.action === 'timeout' && (!input.durationMs || input.durationMs < 60_000 || input.durationMs > MAX_TIMEOUT_MS)) {
                    throw new HttpError(400, 'La duración debe estar entre 1 minuto y 28 días.');
                }
                break;
            case 'kick':
                if (!member) throw new HttpError(400, 'El usuario no está en el servidor.');
                if (!member.kickable) throw new HttpError(400, 'El bot no puede expulsar a este usuario (rol igual o superior, o falta el permiso "Expulsar miembros").');
                break;
            case 'ban':
                if (member && !member.bannable) throw new HttpError(400, 'El bot no puede banear a este usuario (rol igual o superior, o falta el permiso "Banear miembros").');
                break;
            case 'unban':
                if (!(await guild.bans.fetch(user.id).catch(() => null))) throw new HttpError(400, 'Ese usuario no está baneado.');
                break;
        }

        // El MD va ANTES de expulsar/banear: después ya no compartiría servidor con el bot.
        let dmStatus: ModCase['dmStatus'] = null;
        const notify = input.notify ?? this.getConfig().dmOnAction;
        const dmTitle = DM_TEXT[input.action];
        if (notify && dmTitle && member) {
            const lines = [`**Motivo:** ${reason}`];
            if (input.action === 'timeout' && input.durationMs) lines.push(`**Duración:** ${fmtDuration(input.durationMs)}`);
            try {
                const r = await this.messages.sendToUser(user.id, {
                    embed: { title: dmTitle, description: lines.join('\n'), color: `#${COLOR[input.action].toString(16).padStart(6, '0')}`, timestamp: true },
                }, { source: 'system', sourceRef: `mod:${input.action}` });
                dmStatus = r.status === 'sent' ? 'sent' : 'failed';
            } catch {
                dmStatus = 'failed';
            }
        }

        this.markRecent(input.action, user.id);
        try {
            switch (input.action) {
                case 'timeout': await member!.timeout(input.durationMs!, auditReason); break;
                case 'untimeout': await member!.timeout(null, auditReason); break;
                case 'kick': await member!.kick(auditReason); break;
                case 'ban': await guild.bans.create(user.id, { reason: auditReason, deleteMessageSeconds: Math.min(Math.max(input.deleteDays ?? 0, 0), 7) * 86400 }); break;
                case 'unban': await guild.bans.remove(user.id, auditReason); break;
            }
        } catch (err) {
            throw new HttpError(400, `Discord rechazó la acción: ${(err as Error).message}`);
        }

        const c = this.addCase({
            userId: user.id, userTag: user.username, action: input.action, reason: reason || null,
            durationMs: input.action === 'timeout' ? input.durationMs! : null,
            moderatorId: mod.userId, moderatorName: mod.username, source: 'panel', dmStatus,
        });
        logger.info(`🛡️ ${LABEL[input.action]} a ${user.username} por ${mod.username}${reason ? `: ${reason}` : ''}`);
        if (this.getConfig().log.modActions) void this.postCase(c);
        return c;
    }

    /** Baneos actuales del servidor. */
    async bans(): Promise<Array<{ userId: string; username: string; avatar: string; reason: string | null }>> {
        const list = await this.guild().bans.fetch().catch(err => { throw new HttpError(400, `No se pudieron leer los baneos: ${(err as Error).message}`); });
        return [...list.values()].map(b => ({ userId: b.user.id, username: b.user.username, avatar: b.user.displayAvatarURL({ size: 64 }), reason: b.reason ?? null }));
    }

    // ────────────────────────── Registro (canal de logs) ──────────────────────────

    private async post(embed: EmbedBuilder): Promise<void> {
        const id = this.getConfig().logChannelId;
        if (!this.active || !id) return;
        const channel = await this.client.channels.fetch(id).catch(() => null);
        if (!channel || !('send' in channel)) return void logger.warn('El canal de registro de moderación no existe o no es de texto.');
        await (channel as { send: (o: unknown) => Promise<unknown> }).send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } })
            .catch(err => logger.warn(`No se pudo publicar en el registro: ${(err as Error).message}`));
    }

    private enabled(e: LogEvent): boolean {
        const cfg = this.getConfig();
        return this.active && !!cfg.logChannelId && cfg.log[e];
    }

    private postCase(c: ModCase): Promise<void> {
        const embed = new EmbedBuilder()
            .setColor(COLOR[c.action])
            .setTitle(`🛡️ ${LABEL[c.action]} · caso #${c.id}`)
            .addFields(
                { name: 'Usuario', value: `<@${c.userId}> (${c.userTag ?? c.userId})`, inline: true },
                { name: 'Moderador', value: c.moderatorId ? `<@${c.moderatorId}>` : (c.moderatorName ?? 'Desconocido'), inline: true },
            );
        if (c.durationMs) embed.addFields({ name: 'Duración', value: fmtDuration(c.durationMs), inline: true });
        if (c.reason) embed.addFields({ name: 'Motivo', value: clip(c.reason) });
        if (c.source === 'discord') embed.setFooter({ text: 'Hecho directamente en Discord' });
        return this.post(embed);
    }

    async onMessageDelete(message: Message | PartialMessage): Promise<void> {
        if (!message.guildId || message.author?.bot || !this.enabled('messageDelete')) return;
        if (this.getConfig().ignoreChannelIds.includes(message.channelId)) return;
        const embed = new EmbedBuilder().setColor(0xed4245).setTitle('🗑️ Mensaje borrado')
            .addFields({ name: 'Canal', value: `<#${message.channelId}>`, inline: true });
        if (message.author) embed.addFields({ name: 'Autor', value: `<@${message.author.id}> (${message.author.username})`, inline: true });
        embed.addFields({ name: 'Contenido', value: message.partial ? '*No estaba en memoria (mensaje antiguo)*' : clip(message.content || '*(sin texto)*') });
        const files = message.attachments?.map(a => a.name).filter(Boolean) ?? [];
        if (files.length) embed.addFields({ name: 'Adjuntos', value: clip(files.join(', ')) });
        await this.post(embed);
    }

    async onMessageUpdate(before: Message | PartialMessage, after: Message | PartialMessage): Promise<void> {
        if (!after.guildId || after.author?.bot || !this.enabled('messageEdit')) return;
        if (this.getConfig().ignoreChannelIds.includes(after.channelId)) return;
        if (!before.partial && before.content === after.content) return; // cambió solo el embed/preview
        const embed = new EmbedBuilder().setColor(0xe8a317).setTitle('✏️ Mensaje editado').setURL(after.url)
            .addFields({ name: 'Canal', value: `<#${after.channelId}>`, inline: true });
        if (after.author) embed.addFields({ name: 'Autor', value: `<@${after.author.id}> (${after.author.username})`, inline: true });
        embed.addFields(
            { name: 'Antes', value: before.partial ? '*No estaba en memoria*' : clip(before.content || '*(vacío)*') },
            { name: 'Después', value: clip(after.content || '*(vacío)*') },
        );
        await this.post(embed);
    }

    async onMemberJoin(member: GuildMember): Promise<void> {
        if (!this.enabled('memberJoin')) return;
        const days = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
        await this.post(new EmbedBuilder().setColor(0x3ba55d).setTitle('📥 Ha entrado')
            .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
            .setDescription(`<@${member.id}> (${member.user.username})`)
            .addFields({ name: 'Cuenta creada', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>${days < 7 ? ' ⚠️ cuenta nueva' : ''}`, inline: true },
                { name: 'Miembros', value: String(member.guild.memberCount), inline: true }));
    }

    async onMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
        if (!this.enabled('memberLeave')) return;
        const roles = member.partial ? [] : member.roles.cache.filter(r => r.id !== member.guild.id).map(r => `<@&${r.id}>`);
        const embed = new EmbedBuilder().setColor(0x8f98a9).setTitle('📤 Ha salido')
            .setDescription(`<@${member.id}> (${member.user?.username ?? member.id})`);
        if (member.joinedTimestamp) embed.addFields({ name: 'Entró', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true });
        if (roles.length) embed.addFields({ name: 'Roles', value: clip(roles.join(' ')) });
        await this.post(embed);
    }

    async onMemberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
        if (before.partial) return; // sin el estado anterior no se puede comparar
        const who = `<@${after.id}> (${after.user.username})`;

        if (this.enabled('roles')) {
            const added = after.roles.cache.filter(r => !before.roles.cache.has(r.id));
            const removed = before.roles.cache.filter(r => !after.roles.cache.has(r.id));
            if (added.size || removed.size) {
                const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Roles cambiados').setDescription(who);
                if (added.size) embed.addFields({ name: 'Añadidos', value: clip(added.map(r => `<@&${r.id}>`).join(' ')) });
                if (removed.size) embed.addFields({ name: 'Quitados', value: clip(removed.map(r => `<@&${r.id}>`).join(' ')) });
                await this.post(embed);
            }
        }

        if (this.enabled('nicknames') && before.nickname !== after.nickname) {
            await this.post(new EmbedBuilder().setColor(0x5865f2).setTitle('🏷️ Apodo cambiado').setDescription(who)
                .addFields({ name: 'Antes', value: before.nickname ?? '*(ninguno)*', inline: true }, { name: 'Después', value: after.nickname ?? '*(ninguno)*', inline: true }));
        }

        const wasOut = before.communicationDisabledUntilTimestamp ?? 0;
        const isOut = after.communicationDisabledUntilTimestamp ?? 0;
        if (wasOut === isOut) return;
        const now = Date.now();
        const started = isOut > now && isOut !== wasOut;
        const ended = !started && wasOut > now;
        if (!started && !ended) return;
        const action: ModAction = started ? 'timeout' : 'untimeout';
        if (this.recent.has(`${action}:${after.id}`)) return; // ya lo registró el panel
        const c = this.addCase({
            userId: after.id, userTag: after.user.username, action, reason: null,
            durationMs: started ? isOut - now : null, moderatorId: null, moderatorName: null, source: 'discord', dmStatus: null,
        });
        if (this.enabled('timeouts')) await this.postCase(c);
    }

    async onBan(ban: GuildBan, added: boolean): Promise<void> {
        const action: ModAction = added ? 'ban' : 'unban';
        if (this.recent.has(`${action}:${ban.user.id}`)) return;
        const c = this.addCase({
            userId: ban.user.id, userTag: ban.user.username, action, reason: ban.reason ?? null,
            durationMs: null, moderatorId: null, moderatorName: null, source: 'discord', dmStatus: null,
        });
        if (this.enabled('bans')) await this.postCase(c);
    }
}
