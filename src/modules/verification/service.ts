import { PermissionFlagsBits, RESTJSONErrorCodes, type Client, type Guild, type GuildMember } from 'discord.js';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { friendlyDiscordError, type MessagesService, type OutgoingPayload } from '../messages/service';
import type { ModerationService } from '../moderation/service';

const logger = new Logger('Verification');
const KEY = 'verification.config';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Con un hueco mayor (bot caído, módulo en pausa…) los avisos ya no serían consecutivos: se empieza de nuevo. */
const MAX_GAP = 2 * DAY;
/** Abrir muchos MD de golpe hace que Discord marque al bot como spam: se atiende a unos pocos por pasada. */
const PER_RUN = 10;
/** Margen para que llegue el evento de salida de alguien recién expulsado. */
const KICK_EVENT_MS = 5 * 60_000;
const DM_CLOSED = friendlyDiscordError({ code: RESTJSONErrorCodes.CannotSendMessagesToThisUser });

/**
 * unverified: solo tiene el rol sin verificar.
 * confirmed: tiene el de sin verificar y el de confirmado, pero no el de verificado.
 */
export const GROUPS = ['unverified', 'confirmed'] as const;
export type Group = typeof GROUPS[number];

export interface GroupConfig {
    /** Días de plazo: se manda un aviso cada día. */
    days: number;
    message: string;
    /** Sale en cada aviso, en el MD de expulsión y en el historial de moderación. */
    reason: string;
}

export interface VerificationConfig {
    enabled: boolean;
    unverifiedRoleId: string | null;
    confirmedRoleId: string | null;
    verifiedRoleId: string | null;
    /** Canal de las normas, que se enlaza en cada aviso. */
    rulesChannelId: string | null;
    /** Donde se menciona a quien tiene los MD cerrados. */
    fallbackChannelId: string | null;
    groups: Record<Group, GroupConfig>;
}

const DEFAULT_CONFIG: VerificationConfig = {
    enabled: false,
    unverifiedRoleId: null,
    confirmedRoleId: null,
    verifiedRoleId: null,
    rulesChannelId: null,
    fallbackChannelId: null,
    groups: {
        unverified: {
            days: 3,
            message: 'Hola {user}, todavía no te has verificado en **{server}**.\n\nAcepta las normas y verifícate. Si no lo haces dentro del plazo, se te considerará un bot y se te expulsará.',
            reason: 'No te has verificado ni has aceptado las normas dentro del plazo, por lo que se te considera un bot.',
        },
        confirmed: {
            days: 10,
            message: 'Hola {user}, ya has confirmado tu participación en **{server}**, pero **todavía te falta verificarte**: confirmar y verificarse son pasos distintos.\n\nAcepta las normas y verifícate para poder ver todo el servidor. Si no lo haces dentro del plazo, se te expulsará.',
            reason: 'Confirmaste tu participación, pero no te has verificado ni has aceptado las normas dentro del plazo.',
        },
    },
};

interface Row {
    user_id: string;
    group_name: Group;
    joined_at: number | null;
    days: number;
    warnings: number;
    warned_at: number | null;
    retry_at: number | null;
    delivery: 'dm' | 'channel' | 'failed' | null;
    error: string | null;
}

export interface PendingMember {
    userId: string;
    username: string;
    displayName: string;
    group: Group;
    days: number;
    warnings: number;
    delivery: Row['delivery'];
    error: string | null;
    /** null = aún no se le ha avisado, el plazo no ha empezado. */
    kickAt: number | null;
}

export interface VerificationStatus {
    problem: string | null;
    members: PendingMember[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const plural = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;

export class VerificationService {
    active = false;
    private running = false;
    /** Cambia al guardar o parar, para que una pasada a medias no actúe con datos antiguos. */
    private revision = 0;
    /** Expulsiones cuyo evento de salida aún no ha recogido Bienvenida. */
    private readonly kicked = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly messages: MessagesService,
        private readonly moderation: ModerationService
    ) {}

    // ────────────────────────── Configuración ──────────────────────────

    getConfig(): VerificationConfig {
        const saved = parseJson<Partial<VerificationConfig>>(getSetting(this.db, KEY, ''), {});
        return {
            ...DEFAULT_CONFIG,
            ...saved,
            groups: {
                unverified: { ...DEFAULT_CONFIG.groups.unverified, ...saved.groups?.unverified },
                confirmed: { ...DEFAULT_CONFIG.groups.confirmed, ...saved.groups?.confirmed },
            },
        };
    }

    setConfig(cfg: VerificationConfig): VerificationConfig {
        if (cfg.enabled) {
            const guild = this.guild();
            if (!guild) throw new HttpError(503, 'El bot aún no ha cargado el servidor.');
            const problem = this.problem(guild, cfg);
            if (problem) throw new HttpError(400, problem);
            for (const id of [cfg.rulesChannelId, cfg.fallbackChannelId]) {
                if (id && !guild.channels.cache.has(id)) throw new HttpError(400, 'Alguno de los canales ya no existe.');
            }
        }

        const before = this.getConfig();
        const restart = (cfg.enabled && !before.enabled)
            || (['unverifiedRoleId', 'confirmedRoleId', 'verifiedRoleId'] as const).some(k => cfg[k] !== before[k]);
        this.db.transaction(() => {
            setSetting(this.db, KEY, JSON.stringify(cfg));
            // Al activar o cambiar los roles nadie hereda un plazo antiguo.
            if (restart) this.db.prepare('DELETE FROM verification_warnings').run();
        })();
        this.revision++;
        publish('verification:changed', {});
        return this.getConfig();
    }

    private guild(): Guild | undefined {
        return this.client.guilds.cache.get(env.guildId);
    }

    /** Si falta un rol no se actúa: sin el de verificado, por ejemplo, cualquiera parecería sin verificar. */
    private problem(guild: Guild, cfg: VerificationConfig): string | null {
        const ids = [cfg.unverifiedRoleId, cfg.confirmedRoleId, cfg.verifiedRoleId];
        if (ids.some(id => !id)) return 'Elige los roles de sin verificar, confirmado y verificado.';
        if (new Set(ids).size !== ids.length) return 'Los tres roles tienen que ser distintos.';
        if (ids.some(id => id === guild.id || !guild.roles.cache.has(id!))) return 'Alguno de los roles ya no existe.';
        return null;
    }

    private classify(member: GuildMember, cfg: VerificationConfig): Group | null {
        const roles = member.roles.cache;
        if (member.user.bot || !roles.has(cfg.unverifiedRoleId!) || roles.has(cfg.verifiedRoleId!)) return null;

        let group: Group;
        if (roles.has(cfg.confirmedRoleId!)) group = 'confirmed';
        else if ([...roles.keys()].every(id => id === cfg.unverifiedRoleId || id === env.guildId)) group = 'unverified';
        else return null;

        if (member.id === member.guild.ownerId || env.panel.adminIds.includes(member.id)) return null;
        return member.permissions.has(PermissionFlagsBits.Administrator) ? null : group;
    }

    // ────────────────────────── Seguimiento ──────────────────────────

    private rows(): Map<string, Row> {
        const rows = this.db.prepare('SELECT * FROM verification_warnings').all() as Row[];
        return new Map(rows.map(r => [r.user_id, r]));
    }

    private save(row: Row): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO verification_warnings (user_id, group_name, joined_at, days, warnings, warned_at, retry_at, delivery, error)
            VALUES (@user_id, @group_name, @joined_at, @days, @warnings, @warned_at, @retry_at, @delivery, @error)
        `).run(row);
    }

    forget(userId: string): void {
        if (this.db.prepare('DELETE FROM verification_warnings WHERE user_id = ?').run(userId).changes) publish('verification:changed', {});
    }

    onMemberUpdate(member: GuildMember): void {
        const cfg = this.getConfig();
        const guild = this.guild();
        if (!cfg.enabled || !guild || this.problem(guild, cfg)) return;
        const row = this.db.prepare('SELECT * FROM verification_warnings WHERE user_id = ?').get(member.id) as Row | undefined;
        if (row && row.group_name !== this.classify(member, cfg)) this.forget(member.id);
    }

    /** El plazo en curso, o uno nuevo si cambió de grupo, volvió a entrar o los avisos se interrumpieron. */
    private track(member: GuildMember, group: Group, cfg: VerificationConfig, saved: Row | undefined, now: number): Row {
        const valid = saved
            && saved.group_name === group
            && saved.joined_at === member.joinedTimestamp
            && (saved.warned_at === null || now - saved.warned_at <= MAX_GAP);
        if (valid) return saved.warnings ? saved : { ...saved, days: cfg.groups[group].days };
        return {
            user_id: member.id, group_name: group, joined_at: member.joinedTimestamp, days: cfg.groups[group].days,
            warnings: 0, warned_at: null, retry_at: null, delivery: null, error: null,
        };
    }

    status(now = Date.now()): VerificationStatus {
        const guild = this.guild();
        if (!guild) return { problem: 'El bot aún no ha cargado el servidor.', members: [] };
        const cfg = this.getConfig();
        const problem = this.problem(guild, cfg);
        if (problem) return { problem, members: [] };

        const rows = this.rows();
        const members: PendingMember[] = [];
        for (const member of guild.members.cache.values()) {
            const group = this.classify(member, cfg);
            if (!group) continue;
            const row = this.track(member, group, cfg, rows.get(member.id), now);
            members.push({
                userId: member.id, username: member.user.username, displayName: member.displayName, group,
                days: row.days, warnings: row.warnings, delivery: row.delivery, error: row.error,
                kickAt: cfg.enabled && row.warned_at !== null ? row.warned_at + (row.days - row.warnings + 1) * DAY : null,
            });
        }
        members.sort((a, b) => (a.kickAt ?? Infinity) - (b.kickAt ?? Infinity) || a.username.localeCompare(b.username));
        return { problem: null, members };
    }

    // ────────────────────────── Avisos y expulsión ──────────────────────────

    /** true una sola vez si esa salida es una expulsión por no verificarse. */
    takeKick(userId: string): boolean {
        clearTimeout(this.kicked.get(userId));
        return this.kicked.delete(userId);
    }

    private markKick(userId: string): void {
        this.kicked.set(userId, setTimeout(() => this.kicked.delete(userId), KICK_EVENT_MS).unref());
    }

    stop(): void {
        this.active = false;
        this.revision++;
    }

    async run(now = Date.now()): Promise<void> {
        // Con Mensajes en pausa tampoco se expulsa: sería hacerlo sin avisar.
        if (this.running || !this.active || !this.messages.active) return;
        const cfg = this.getConfig();
        const guild = this.guild();
        if (!cfg.enabled || !guild || guild.available === false || this.problem(guild, cfg)) return;

        this.running = true;
        const revision = this.revision;
        try {
            const rows = this.rows();
            for (const id of rows.keys()) {
                const member = guild.members.cache.get(id);
                if (!member || !this.classify(member, cfg)) this.forget(id);
            }

            const due: Array<{ id: string; at: number }> = [];
            for (const member of guild.members.cache.values()) {
                const group = this.classify(member, cfg);
                if (!group) continue;
                const row = this.track(member, group, cfg, rows.get(member.id), now);
                const at = row.retry_at ?? (row.warned_at === null ? 0 : row.warned_at + DAY);
                if (at <= now) due.push({ id: member.id, at });
            }
            // Primero quien ya tiene el plazo en marcha, para que sus avisos no dejen de ser diarios.
            due.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));

            for (const [i, { id }] of due.slice(0, PER_RUN).entries()) {
                if (i) await sleep(1100);
                if (!this.canAct(guild, cfg, revision)) break;
                await this.process(guild, id, cfg, revision, now)
                    .catch(err => logger.warn(`No se pudo revisar a ${id}: ${(err as Error).message}`));
            }
            if (due.length) publish('verification:changed', {});
        } finally {
            this.running = false;
        }
    }

    private canAct(guild: Guild, cfg: VerificationConfig, revision: number): boolean {
        return this.active && this.messages.active && this.revision === revision && !this.problem(guild, cfg);
    }

    private async process(guild: Guild, id: string, cfg: VerificationConfig, revision: number, now: number): Promise<void> {
        let member: GuildMember;
        try {
            // force: la caché puede no saber que se acaba de verificar.
            member = await guild.members.fetch({ user: id, force: true });
        } catch (err) {
            if ((err as { code?: number }).code === RESTJSONErrorCodes.UnknownMember) return this.forget(id);
            throw err;
        }
        if (!this.canAct(guild, cfg, revision)) return;
        const group = this.classify(member, cfg);
        if (!group) return this.forget(id);

        const saved = this.db.prepare('SELECT * FROM verification_warnings WHERE user_id = ?').get(id) as Row | undefined;
        const row = this.track(member, group, cfg, saved, now);

        if (!member.kickable) {
            // No se le amenaza con una expulsión que el bot no puede cumplir.
            this.save({ ...row, retry_at: now + HOUR, error: 'El bot no puede expulsarle: revisa su permiso «Expulsar miembros» y la posición de su rol.' });
        } else if (row.warnings >= row.days) {
            if (row.warned_at !== null && now - row.warned_at >= DAY) await this.kick(member, row, cfg, revision, now);
        } else if (row.warned_at === null || now - row.warned_at >= DAY) {
            await this.warn(member, row, cfg, revision, now);
        }
    }

    private async warn(member: GuildMember, row: Row, cfg: VerificationConfig, revision: number, now: number): Promise<void> {
        const left = row.days - row.warnings;
        const deadline = Math.floor((now + left * DAY) / 1000);
        const { message, reason } = cfg.groups[row.group_name];
        const details = [
            `⏳ **Tiempo restante:** ${plural(left)} (hasta el <t:${deadline}:f>, <t:${deadline}:R>)`,
            `📌 **Motivo de la expulsión:** ${reason}`,
        ];
        if (cfg.rulesChannelId) details.push(`✅ **Normas y verificación:** <#${cfg.rulesChannelId}>`);
        const embed: OutgoingPayload['embed'] = {
            title: `⚠️ Verifícate o se te expulsará en ${plural(left)}`,
            description: `${message}\n\n${details.join('\n')}`,
            color: left === 1 ? '#ED4245' : '#E8A317',
            footer: `Aviso ${row.warnings + 1} de ${row.days}`,
        };
        const meta = { source: 'system', sourceRef: `verification:${row.group_name}` } as const;

        const dm = await this.messages.sendToUser(member.id, { embed }, meta);
        let delivery: Row['delivery'] = dm.status === 'sent' ? 'dm' : 'failed';
        let error = dm.status === 'sent' ? null : dm.error;
        if (delivery === 'failed' && cfg.fallbackChannelId) {
            // La mención va en el texto: dentro de un embed no notifica.
            const post = await this.messages.sendToChannel(cfg.fallbackChannelId, { content: '{mention}', embed }, meta, { about: { user: member.user, member } });
            if (post.status === 'sent') [delivery, error] = ['channel', null];
            else error = `Ni por MD ni en el canal de avisos: ${post.error}`;
        }
        if (this.revision !== revision) return;

        // Los MD cerrados cuentan (si no, bastaría con cerrarlos para no ser expulsado); otros fallos se reintentan.
        const counts = delivery !== 'failed' || (!cfg.fallbackChannelId && dm.error === DM_CLOSED);
        this.save(counts
            ? { ...row, warnings: row.warnings + 1, warned_at: now, retry_at: null, delivery, error }
            : { ...row, retry_at: now + HOUR, delivery, error });
    }

    private async kick(member: GuildMember, row: Row, cfg: VerificationConfig, revision: number, now: number): Promise<void> {
        try {
            await this.moderation.act(
                { action: 'kick', userId: member.id, reason: cfg.groups[row.group_name].reason, notify: true, beforeApply: () => this.markKick(member.id) },
                { userId: this.client.user!.id, username: 'Verificación automática' }
            );
            this.forget(member.id);
        } catch (err) {
            this.takeKick(member.id);
            logger.warn(`No se pudo expulsar a ${member.user.username}: ${(err as Error).message}`);
            // act() avisa por MD antes de expulsar: se reintenta con calma para no repetirle el mensaje.
            if (this.revision === revision) this.save({ ...row, retry_at: now + 12 * HOUR, error: (err as Error).message });
        }
    }
}
