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

export const LOG_EVENTS = ['messageDelete', 'messageEdit', 'memberJoin', 'memberLeave', 'roles', 'nicknames', 'timeouts', 'bans', 'modActions', 'reports'] as const;
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
    log: { messageDelete: true, messageEdit: true, memberJoin: true, memberLeave: true, roles: true, nicknames: true, timeouts: true, bans: true, modActions: true, reports: true },
    ignoreChannelIds: [],
    dmOnAction: true,
};

export type CaseSource = 'panel' | 'discord' | 'minecraft';

interface CaseRow {
    id: number;
    user_id: string;
    user_tag: string | null;
    action: ModAction;
    reason: string | null;
    duration_ms: number | null;
    moderator_id: string | null;
    moderator_name: string | null;
    source: CaseSource;
    dm_status: 'sent' | 'failed' | null;
    created_at: number;
    mc_name: string | null;
    expires_at: number | null;
    lifted_at: number | null;
    origin_server_id: number | null;
    origin_ref: string | null;
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
    source: CaseSource;
    dmStatus: 'sent' | 'failed' | null;
    createdAt: number;
    /** Casos del juego: cuenta de Minecraft sancionada. */
    mcName: string | null;
    /** Baneo temporal hecho en el juego: cuándo se levanta (null = permanente o no aplica). */
    expiresAt: number | null;
    /** Servidor de Minecraft donde se hizo (source = 'minecraft'). */
    originServerId: number | null;
}

/** Campos opcionales al crear un caso. */
type NewCase = Omit<ModCase, 'id' | 'createdAt' | 'mcName' | 'expiresAt' | 'originServerId'>
    & Partial<Pick<ModCase, 'mcName' | 'expiresAt' | 'originServerId'>> & { originRef?: string | null };

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
    mcName: r.mc_name,
    expiresAt: r.expires_at,
    originServerId: r.origin_server_id,
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
    /** Se llama justo antes de aplicarla en Discord, ya enviado el MD: su evento puede llegar antes que la respuesta. */
    beforeApply?: () => void;
}

export interface Moderator { userId: string; username: string }

/** Lo que manda un servidor de Minecraft (mod kb_moderation) al sancionar en el juego. */
export const MC_ACTIONS = ['warn', 'note', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'delete'] as const;
export type McAction = typeof MC_ACTIONS[number];

export interface McActionInput {
    /** Id de la sanción en el servidor: si se reintenta, no se duplica. */
    ref: string;
    action: McAction;
    /** Cuenta de Discord vinculada al jugador sancionado. */
    userId: string;
    mcName: string | null;
    reason: string;
    /** timeout: duración (0 = permanente en el juego; en Discord se queda en el máximo, 28 días). */
    durationMs?: number;
    /** ban temporal: cuándo levantarlo (null = permanente). */
    expiresAt?: number | null;
    /** delete: caso del bot que se retira (un aviso o una nota quitados en el juego). */
    caseId?: number;
    moderator: { discordId: string | null; name: string };
}

/** Un cambio para los servidores de Minecraft: un caso nuevo, un caso borrado o un reporte cerrado. */
export interface SyncEvent {
    id: number;
    kind: 'case' | 'delete' | 'report_closed';
    /** case / delete */
    caseId?: number;
    case?: ModCase | null;
    /** report_closed: el reporte en el servidor que lo creó y quién lo cerró */
    reportRef?: string;
    closedBy?: string | null;
}

export interface McReport {
    id: number;
    serverId: number;
    ref: string;
    reporterName: string;
    reporterDiscordId: string | null;
    targetName: string;
    targetDiscordId: string | null;
    reason: string;
    location: string | null;
    createdAt: number;
    closedAt: number | null;
    closedBy: string | null;
    /** MD de "hemos recibido tu reporte" a quien lo hizo: así puede seguir hablando con el staff por MD. */
    dmStatus: 'sent' | 'failed' | null;
}

interface ReportRow {
    id: number; server_id: number; ref: string; reporter_name: string; reporter_discord_id: string | null; target_name: string;
    target_discord_id: string | null; reason: string; location: string | null; created_at: number; closed_at: number | null; closed_by: string | null;
    dm_status: 'sent' | 'failed' | null;
}

const toReport = (r: ReportRow): McReport => ({
    id: r.id, serverId: r.server_id, ref: r.ref, reporterName: r.reporter_name, reporterDiscordId: r.reporter_discord_id,
    targetName: r.target_name, targetDiscordId: r.target_discord_id, reason: r.reason, location: r.location,
    createdAt: r.created_at, closedAt: r.closed_at, closedBy: r.closed_by, dmStatus: r.dm_status,
});

const MC_LABEL: Partial<Record<McAction, string>> = { kick: 'Expulsado de Minecraft' };

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

    deleteCase(id: number, originServerId: number | null = null): void {
        this.db.transaction(() => {
            const res = this.db.prepare('DELETE FROM mod_cases WHERE id = ?').run(id);
            if (!res.changes) throw new HttpError(404, 'Caso no encontrado');
            this.db.prepare("INSERT INTO mod_sync_events (kind, target_id, origin_server_id, created_at) VALUES ('delete', ?, ?, ?)")
                .run(id, originServerId, Date.now());
        })();
        publish('moderation:cases', { id });
    }

    private addCase(c: NewCase): ModCase {
        const out = this.db.transaction(() => {
            const res = this.db.prepare(`
                INSERT INTO mod_cases (user_id, user_tag, action, reason, duration_ms, moderator_id, moderator_name, source, dm_status, created_at,
                                       mc_name, expires_at, origin_server_id, origin_ref)
                VALUES (@userId, @userTag, @action, @reason, @durationMs, @moderatorId, @moderatorName, @source, @dmStatus, @createdAt,
                        @mcName, @expiresAt, @originServerId, @originRef)
            `).run({ mcName: null, expiresAt: null, originServerId: null, originRef: null, ...c, createdAt: Date.now() });
            // Los servidores de Minecraft lo leen de aquí (menos el que lo creó, que ya lo tiene).
            this.db.prepare("INSERT INTO mod_sync_events (kind, target_id, origin_server_id, created_at) VALUES ('case', ?, ?, ?)")
                .run(res.lastInsertRowid, c.originServerId ?? null, Date.now());
            return toCase(this.db.prepare('SELECT * FROM mod_cases WHERE id = ?').get(res.lastInsertRowid) as CaseRow);
        })();
        // Un desbaneo, venga de donde venga, cierra los baneos temporales pendientes de ese usuario.
        if (out.action === 'unban') this.db.prepare('UPDATE mod_cases SET lifted_at = ? WHERE user_id = ? AND action = \'ban\' AND expires_at IS NOT NULL AND lifted_at IS NULL').run(Date.now(), out.userId);
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
        input.beforeApply?.();
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

    // ────────────────────────── Minecraft (mod kb_moderation) ──────────────────────────

    /**
     * Una sanción hecha en un servidor de Minecraft: se aplica en Discord lo que se pueda (sin que un fallo
     * impida registrarla, porque en el juego ya está hecha) y se guarda como caso. Idempotente por `ref`.
     */
    async fromMinecraft(serverId: number, input: McActionInput): Promise<{ caseId: number | null }> {
        const existing = this.db.prepare('SELECT id FROM mod_cases WHERE origin_server_id = ? AND origin_ref = ?').get(serverId, input.ref) as { id: number } | undefined;
        if (existing) return { caseId: existing.id };

        if (input.action === 'delete') {
            if (input.caseId && this.db.prepare('SELECT 1 FROM mod_cases WHERE id = ?').get(input.caseId)) this.deleteCase(input.caseId, serverId);
            return { caseId: null };
        }

        const guild = this.guild();
        const reason = input.reason.trim();
        const auditReason = `${reason || LABEL[input.action as ModAction] || input.action} · por ${input.moderator.name} (Minecraft)`.slice(0, 500);
        const member = await guild.members.fetch(input.userId).catch(() => null);
        const user = member?.user ?? await this.client.users.fetch(input.userId).catch(() => null);
        const tag = user?.username ?? null;
        let dmStatus: ModCase['dmStatus'] = null;
        const notify = this.getConfig().dmOnAction;
        const timeoutMs = input.action === 'timeout' ? Math.min(input.durationMs && input.durationMs > 0 ? input.durationMs : MAX_TIMEOUT_MS, MAX_TIMEOUT_MS) : 0;

        const discord = async (what: string, fn: () => Promise<unknown>) => {
            try {
                await fn();
            } catch (err) {
                logger.warn(`Minecraft → Discord: no se pudo ${what} a ${tag ?? input.userId}: ${(err as Error).message}`);
            }
        };

        const dmTitle = DM_TEXT[input.action as ModAction];
        if (notify && dmTitle && member) {
            const lines = [`**Motivo:** ${reason || 'Sin motivo'}`];
            if (input.action === 'timeout') lines.push(`**Duración:** ${input.durationMs ? fmtDuration(input.durationMs) : 'permanente en el juego'}`);
            if (input.action === 'ban' && input.expiresAt) lines.push(`**Hasta:** <t:${Math.floor(input.expiresAt / 1000)}:f>`);
            if (input.mcName) lines.push(`**Cuenta de Minecraft:** ${input.mcName}`);
            try {
                const r = await this.messages.sendToUser(input.userId, {
                    embed: { title: dmTitle, description: lines.join('\n'), color: `#${COLOR[input.action as ModAction].toString(16).padStart(6, '0')}`, timestamp: true },
                }, { source: 'system', sourceRef: `mod:mc:${input.action}` });
                dmStatus = r.status === 'sent' ? 'sent' : 'failed';
            } catch {
                dmStatus = 'failed';
            }
        }

        switch (input.action) {
            case 'timeout':
                if (member?.moderatable) {
                    this.markRecent('timeout', input.userId);
                    await discord('silenciar', () => member.timeout(timeoutMs, auditReason));
                }
                break;
            case 'untimeout':
                if (member?.moderatable && member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) {
                    this.markRecent('untimeout', input.userId);
                    await discord('quitar el silencio', () => member.timeout(null, auditReason));
                }
                break;
            case 'ban':
                if (!member || member.bannable) {
                    this.markRecent('ban', input.userId);
                    await discord('banear', () => guild.bans.create(input.userId, { reason: auditReason }));
                }
                break;
            case 'unban':
                if (await guild.bans.fetch(input.userId).catch(() => null)) {
                    this.markRecent('unban', input.userId);
                    await discord('desbanear', () => guild.bans.remove(input.userId, auditReason));
                }
                break;
            default:
                break; // warn, note y kick (del juego) no cambian nada en Discord
        }

        // La expulsión del juego no echa de Discord: queda como nota en el historial.
        const action: ModAction = input.action === 'kick' ? 'note' : input.action as ModAction;
        const label = MC_LABEL[input.action];
        const c = this.addCase({
            userId: input.userId, userTag: tag, action,
            reason: label ? `${label}${reason ? `: ${reason}` : ''}` : (reason || null),
            durationMs: input.action === 'timeout' ? (input.durationMs || null) : null,
            moderatorId: input.moderator.discordId, moderatorName: input.moderator.name, source: 'minecraft', dmStatus,
            mcName: input.mcName, expiresAt: input.action === 'ban' ? (input.expiresAt ?? null) : null,
            originServerId: serverId, originRef: input.ref,
        });
        logger.info(`🛡️ ${LABEL[action]} a ${tag ?? input.userId}${input.mcName ? ` (${input.mcName})` : ''} desde Minecraft por ${input.moderator.name}${reason ? `: ${reason}` : ''}`);
        if (this.getConfig().log.modActions) void this.postCase(c);
        return { caseId: c.id };
    }

    /** Cambios después de `after` para un servidor de Minecraft (sin los que creó él). */
    feed(serverId: number, after: number, limit = 200): { events: SyncEvent[]; cursor: number } {
        const rows = this.db.prepare('SELECT * FROM mod_sync_events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit) as Array<{
            id: number; kind: SyncEvent['kind']; target_id: number; origin_server_id: number | null;
        }>;
        const getCase = this.db.prepare('SELECT * FROM mod_cases WHERE id = ?');
        const getReport = this.db.prepare('SELECT * FROM mc_reports WHERE id = ?');
        const events: SyncEvent[] = [];
        for (const r of rows) {
            if (r.origin_server_id === serverId) continue;
            if (r.kind === 'report_closed') {
                // Solo al servidor donde se hizo el reporte: los reportes son de cada servidor.
                const rep = getReport.get(r.target_id) as ReportRow | undefined;
                if (rep && rep.server_id === serverId) events.push({ id: r.id, kind: r.kind, reportRef: rep.ref, closedBy: rep.closed_by });
                continue;
            }
            const row = r.kind === 'case' ? getCase.get(r.target_id) as CaseRow | undefined : undefined;
            if (r.kind === 'case' && !row) continue; // se borró después: llegará su evento 'delete'
            events.push({ id: r.id, kind: r.kind, caseId: r.target_id, case: row ? toCase(row) : null });
        }
        return { events, cursor: rows.length ? rows[rows.length - 1].id : after };
    }

    /** Levanta en Discord los baneos temporales hechos en el juego que ya han vencido. */
    async liftExpiredBans(now = Date.now()): Promise<number> {
        const due = this.db.prepare("SELECT * FROM mod_cases WHERE action = 'ban' AND expires_at IS NOT NULL AND expires_at <= ? AND lifted_at IS NULL")
            .all(now) as CaseRow[];
        for (const r of due) {
            this.db.prepare('UPDATE mod_cases SET lifted_at = ? WHERE id = ?').run(now, r.id);
            const guild = this.client.guilds.cache.get(env.guildId);
            if (guild && await guild.bans.fetch(r.user_id).catch(() => null)) {
                this.markRecent('unban', r.user_id);
                await guild.bans.remove(r.user_id, 'Fin del baneo temporal (Minecraft)').catch(err =>
                    logger.warn(`No se pudo levantar el baneo temporal de ${r.user_tag ?? r.user_id}: ${(err as Error).message}`));
            }
            // Origen = el servidor del baneo: allí ya ha vencido solo; los demás lo levantan con este caso.
            const c = this.addCase({
                userId: r.user_id, userTag: r.user_tag, action: 'unban', reason: 'Fin del baneo temporal', durationMs: null,
                moderatorId: null, moderatorName: 'Automático', source: 'minecraft', dmStatus: null,
                mcName: r.mc_name, originServerId: r.origin_server_id,
            });
            if (this.getConfig().log.modActions) void this.postCase(c);
        }
        return due.length;
    }

    // ────────────────────────── Reportes del juego ──────────────────────────

    reports(q: { open?: boolean; limit?: number } = {}): McReport[] {
        const where = q.open === undefined ? '' : q.open ? 'WHERE closed_at IS NULL' : 'WHERE closed_at IS NOT NULL';
        return (this.db.prepare(`SELECT * FROM mc_reports ${where} ORDER BY id DESC LIMIT ?`).all(Math.min(q.limit ?? 100, 500)) as ReportRow[]).map(toReport);
    }

    /** Un /report del juego. Idempotente por (servidor, ref). */
    addReport(serverId: number, r: { ref: string; reporterName: string; reporterDiscordId: string | null; targetName: string;
        targetDiscordId: string | null; reason: string; location: string | null }): McReport {
        const existing = this.db.prepare('SELECT * FROM mc_reports WHERE server_id = ? AND ref = ?').get(serverId, r.ref) as ReportRow | undefined;
        if (existing) return toReport(existing);
        const res = this.db.prepare(`
            INSERT INTO mc_reports (server_id, ref, reporter_name, reporter_discord_id, target_name, target_discord_id, reason, location, created_at)
            VALUES (@serverId, @ref, @reporterName, @reporterDiscordId, @targetName, @targetDiscordId, @reason, @location, @createdAt)
        `).run({ ...r, serverId, createdAt: Date.now() });
        const out = toReport(this.db.prepare('SELECT * FROM mc_reports WHERE id = ?').get(res.lastInsertRowid) as ReportRow);
        publish('moderation:reports', out);
        logger.info(`🚩 Reporte de ${out.reporterName} sobre ${out.targetName}: ${out.reason}`);
        if (this.enabled('reports')) {
            const embed = new EmbedBuilder().setColor(0xed4245).setTitle(`🚩 Reporte del juego #${out.id}`)
                .addFields(
                    { name: 'Reportado', value: out.targetDiscordId ? `${out.targetName} (<@${out.targetDiscordId}>)` : out.targetName, inline: true },
                    { name: 'Por', value: out.reporterDiscordId ? `${out.reporterName} (<@${out.reporterDiscordId}>)` : out.reporterName, inline: true },
                    { name: 'Motivo', value: clip(out.reason) },
                );
            if (out.location) embed.addFields({ name: 'Dónde', value: out.location });
            void this.post(embed);
        }
        if (out.reporterDiscordId) void this.dmReporter(out, 'received');
        return out;
    }

    /**
     * MD a quien hizo el reporte: al recibirlo (con la invitación a responder, que llega a la bandeja del panel)
     * y al cerrarlo. Lo que conteste aparece en la conversación del reporte en el panel.
     */
    private async dmReporter(r: McReport, what: 'received' | 'closed'): Promise<void> {
        const embed = what === 'received'
            ? {
                title: `🚩 Hemos recibido tu reporte #${r.id}`,
                description: [
                    `**Sobre:** ${r.targetName}`,
                    `**Motivo:** ${clip(r.reason, 500)}`,
                    '',
                    'El staff lo revisará lo antes posible.',
                    'Si quieres añadir algo (pruebas, capturas, más detalles), **responde a este mensaje**: lo leerá el staff y te contestará por aquí.',
                ].join('\n'),
                color: '#ed4245',
                timestamp: true,
            }
            : {
                title: `✅ Tu reporte #${r.id} se ha cerrado`,
                description: `Gracias por avisar sobre **${r.targetName}**. El staff ya lo ha revisado.`,
                color: '#3ba55d',
                timestamp: true,
            };
        let status: 'sent' | 'failed' = 'failed';
        try {
            const res = await this.messages.sendToUser(r.reporterDiscordId!, { embed }, { source: 'system', sourceRef: `report:${r.id}:${what}` });
            status = res.status === 'sent' ? 'sent' : 'failed';
        } catch (err) {
            logger.warn(`No se pudo escribir por MD a ${r.reporterName} por su reporte #${r.id}: ${(err as Error).message}`);
        }
        if (what === 'received') {
            this.db.prepare('UPDATE mc_reports SET dm_status = ? WHERE id = ?').run(status, r.id);
            publish('moderation:reports', { id: r.id });
        }
    }

    /** Cierra un reporte. Desde el panel se avisa al servidor del juego; desde el juego, no se le devuelve. */
    closeReport(id: number, by: string, fromServerId: number | null = null): McReport {
        const row = this.db.prepare('SELECT * FROM mc_reports WHERE id = ?').get(id) as ReportRow | undefined;
        if (!row) throw new HttpError(404, 'Reporte no encontrado');
        if (row.closed_at) return toReport(row);
        this.db.transaction(() => {
            this.db.prepare('UPDATE mc_reports SET closed_at = ?, closed_by = ? WHERE id = ?').run(Date.now(), by, id);
            this.db.prepare("INSERT INTO mod_sync_events (kind, target_id, origin_server_id, created_at) VALUES ('report_closed', ?, ?, ?)")
                .run(id, fromServerId, Date.now());
        })();
        const out = toReport(this.db.prepare('SELECT * FROM mc_reports WHERE id = ?').get(id) as ReportRow);
        publish('moderation:reports', out);
        if (out.reporterDiscordId) void this.dmReporter(out, 'closed');
        return out;
    }

    /** Un reporte cerrado en el juego (por su ref en ese servidor). */
    closeReportFromServer(serverId: number, ref: string, by: string): void {
        const row = this.db.prepare('SELECT id FROM mc_reports WHERE server_id = ? AND ref = ?').get(serverId, ref) as { id: number } | undefined;
        if (row) this.closeReport(row.id, by, serverId);
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
        if (c.mcName) embed.addFields({ name: 'Minecraft', value: c.mcName, inline: true });
        if (c.expiresAt) embed.addFields({ name: 'Hasta', value: `<t:${Math.floor(c.expiresAt / 1000)}:f>`, inline: true });
        if (c.source === 'discord') embed.setFooter({ text: 'Hecho directamente en Discord' });
        if (c.source === 'minecraft') embed.setFooter({ text: 'Hecho en el servidor de Minecraft' });
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
