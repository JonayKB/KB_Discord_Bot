import { EmbedBuilder, type Client, type Guild, type GuildMember, type Message, type MessageReaction, type PartialMessage, type PartialMessageReaction, type PartialUser, type User } from 'discord.js';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError } from '../../core/http';
import { Logger } from '../../utils/Logger';

const logger = new Logger('ReactionRoles');

/**
 * Qué pasa con el rol al reaccionar y al quitar la reacción:
 *  - toggle:  reaccionar lo da, quitar la reacción lo quita (lo normal).
 *  - add:     reaccionar lo da y ya no se pierde aunque se quite la reacción.
 *  - remove:  reaccionar lo quita (p. ej. quitar "Sin verificar").
 *  - reverse: reaccionar lo quita y quitar la reacción lo devuelve.
 *  - click:   cada reacción lo da o lo quita; el bot borra la reacción al momento.
 */
export const BEHAVIORS = ['toggle', 'add', 'remove', 'reverse', 'click'] as const;
export type Behavior = typeof BEHAVIORS[number];

type Action = 'give' | 'take' | 'flip' | null;
const RULES: Record<Behavior, { add: Action; remove: Action }> = {
    toggle: { add: 'give', remove: 'take' },
    add: { add: 'give', remove: null },
    remove: { add: 'take', remove: null },
    reverse: { add: 'take', remove: 'give' },
    click: { add: 'flip', remove: null },
};

/** Comportamientos que "dan" el rol al reaccionar (los que cuentan para el modo exclusivo). */
const GIVES_ON_ADD: Behavior[] = ['toggle', 'add', 'click'];

const LIST_SUFFIX: Record<Behavior, string> = {
    toggle: '',
    add: ' · *permanente*',
    remove: ' · *te lo quita*',
    reverse: ' · *te lo quita (quita la reacción para recuperarlo)*',
    click: ' · *pulsa para activar/desactivar*',
};

interface PanelRow {
    id: number;
    name: string;
    enabled: number;
    exclusive: number;
    channel_id: string | null;
    message_id: string | null;
    manage_embed: number;
    title: string;
    description: string;
    color: string;
    show_list: number;
    legacy: number;
    created_at: number;
}

interface EntryRow {
    id: number;
    panel_id: number;
    emoji: string;
    role_id: string;
    behavior: Behavior;
    label: string;
    position: number;
}

export interface ReactionEntry {
    id: number;
    emoji: string;
    roleId: string;
    behavior: Behavior;
    label: string;
}

export interface ReactionPanel {
    id: number;
    name: string;
    enabled: boolean;
    exclusive: boolean;
    channelId: string | null;
    messageId: string | null;
    manageEmbed: boolean;
    title: string;
    description: string;
    color: string;
    showList: boolean;
    legacy: boolean;
    createdAt: number;
    entries: ReactionEntry[];
}

export type EntryInput = Omit<ReactionEntry, 'id'>;
export type PanelInput = Pick<ReactionPanel, 'name' | 'enabled' | 'exclusive' | 'title' | 'description' | 'color' | 'showList'> & { entries: EntryInput[] };
export type PanelSource = { type: 'new'; channelId: string } | { type: 'existing'; channelId: string; messageId: string };

/** Resultado de una operación que también toca Discord: se guarda aunque Discord falle, y se avisa. */
export interface SaveResult { panel: ReactionPanel; warnings: string[] }

// ────────────────────────── Emojis ──────────────────────────

const CUSTOM_RE = /^<(a?):(\w{2,32}):(\d{17,21})>$/;
const NAME_RE = /^:?(\w{2,32}):?$/;

/** ¿El emoji guardado corresponde al de la reacción? (los antiguos solo guardaban el nombre) */
export function emojiMatches(stored: string, emoji: { id: string | null; name: string | null }): boolean {
    const m = CUSTOM_RE.exec(stored);
    if (m) return emoji.id === m[3];
    return emoji.name === stored;
}

/** Convierte lo que escribe el usuario (😀, :nombre:, <:nombre:id> o el ID) en lo que se guarda. */
export function normalizeEmoji(guild: Guild | undefined, raw: string): string {
    const v = raw.trim();
    if (!v) throw new HttpError(400, 'Falta el emoji.');
    if (CUSTOM_RE.test(v)) return v;
    const byId = /^\d{17,21}$/.test(v) ? guild?.emojis.cache.get(v) : undefined;
    if (byId) return byId.toString();
    const name = NAME_RE.exec(v);
    if (name) {
        const found = guild?.emojis.cache.find(e => e.name === name[1]);
        if (!found) throw new HttpError(400, `El emoji "${v}" no existe en el servidor.`);
        return found.toString();
    }
    if (/\s/.test(v) || v.length > 32) throw new HttpError(400, `"${v}" no parece un emoji.`);
    return v;
}

const reactionKey = (messageId: string, emoji: { id: string | null; name: string | null }, userId: string) =>
    `${messageId}:${emoji.id ?? emoji.name}:${userId}`;

const toEntry = (r: EntryRow): ReactionEntry => ({ id: r.id, emoji: r.emoji, roleId: r.role_id, behavior: r.behavior, label: r.label });

type AnyReaction = MessageReaction | PartialMessageReaction;

export class ReactionRolesService {
    /** Reacciones que quita el propio bot: su evento "remove" no debe volver a tocar roles. */
    private readonly suppressed = new Set<string>();
    active = false;

    constructor(private readonly client: Client, private readonly db: DB) {}

    private guild(): Guild | undefined {
        return this.client.guilds.cache.get(env.guildId);
    }

    // ────────────────────────── Lectura ──────────────────────────

    private toPanel(r: PanelRow): ReactionPanel {
        const entries = (this.db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY position, id').all(r.id) as EntryRow[]).map(toEntry);
        return {
            id: r.id,
            name: r.name,
            enabled: !!r.enabled,
            exclusive: !!r.exclusive,
            channelId: r.channel_id,
            messageId: r.message_id,
            manageEmbed: !!r.manage_embed,
            title: r.title,
            description: r.description,
            color: r.color,
            showList: !!r.show_list,
            legacy: !!r.legacy,
            createdAt: r.created_at,
            entries,
        };
    }

    list(): ReactionPanel[] {
        return (this.db.prepare('SELECT * FROM reaction_panels ORDER BY id').all() as PanelRow[]).map(r => this.toPanel(r));
    }

    get(id: number): ReactionPanel | null {
        const row = this.db.prepare('SELECT * FROM reaction_panels WHERE id = ?').get(id) as PanelRow | undefined;
        return row ? this.toPanel(row) : null;
    }

    require(id: number): ReactionPanel {
        const p = this.get(id);
        if (!p) throw new HttpError(404, 'Mensaje de roles no encontrado');
        return p;
    }

    private byMessage(messageId: string): ReactionPanel | null {
        const row = this.db.prepare('SELECT * FROM reaction_panels WHERE message_id = ?').get(messageId) as PanelRow | undefined;
        return row ? this.toPanel(row) : null;
    }

    /** Problemas que impedirían dar un rol (no existe, o está por encima del bot). */
    roleProblems(p: ReactionPanel): Record<string, string> {
        const guild = this.guild();
        const out: Record<string, string> = {};
        if (!guild) return out;
        for (const e of p.entries) {
            const role = guild.roles.cache.get(e.roleId);
            if (!role) out[e.roleId] = 'El rol ya no existe';
            else if (role.managed) out[e.roleId] = 'Es un rol gestionado por una integración';
            else if (role.editable === false) out[e.roleId] = 'El rol está por encima del rol del bot (o le falta "Gestionar roles")';
        }
        return out;
    }

    // ────────────────────────── CRUD ──────────────────────────

    /** Valida y normaliza los emojis/roles antes de guardar. */
    prepare(input: PanelInput): PanelInput {
        const guild = this.guild();
        const entries = input.entries.map(e => {
            if (!BEHAVIORS.includes(e.behavior)) throw new HttpError(400, `Comportamiento no válido: ${e.behavior}`);
            if (!e.roleId) throw new HttpError(400, 'Cada reacción necesita un rol.');
            if (guild && !guild.roles.cache.has(e.roleId)) throw new HttpError(400, 'Uno de los roles ya no existe en el servidor.');
            return { ...e, emoji: normalizeEmoji(guild, e.emoji) };
        });
        if (!entries.length) throw new HttpError(400, 'Añade al menos una reacción.');
        const uniqueEmojis = new Set(entries.map(e => e.emoji));
        if (uniqueEmojis.size > 20) throw new HttpError(400, 'Discord permite como máximo 20 reacciones distintas por mensaje.');
        return { ...input, entries };
    }

    private saveEntries(panelId: number, entries: EntryInput[]): void {
        this.db.prepare('DELETE FROM reaction_roles WHERE panel_id = ?').run(panelId);
        const ins = this.db.prepare('INSERT INTO reaction_roles (panel_id, emoji, role_id, behavior, label, position) VALUES (?, ?, ?, ?, ?, ?)');
        entries.forEach((e, i) => ins.run(panelId, e.emoji, e.roleId, e.behavior, e.label, i));
    }

    private params(i: PanelInput) {
        return {
            name: i.name,
            enabled: i.enabled ? 1 : 0,
            exclusive: i.exclusive ? 1 : 0,
            title: i.title,
            description: i.description,
            color: i.color,
            showList: i.showList ? 1 : 0,
        };
    }

    async create(raw: PanelInput, source: PanelSource): Promise<SaveResult> {
        const input = this.prepare(raw);
        let messageId: string | null = null;

        if (source.type === 'existing') {
            const message = await this.fetchMessage(source.channelId, source.messageId);
            if (!message) throw new HttpError(400, 'No se encontró ese mensaje en el canal (revisa el ID).');
            if (this.byMessage(message.id)) throw new HttpError(400, 'Ese mensaje ya tiene roles por reacción configurados.');
            messageId = message.id;
        }

        const id = this.db.transaction(() => {
            const res = this.db.prepare(`
                INSERT INTO reaction_panels (name, enabled, exclusive, channel_id, message_id, manage_embed, title, description, color, show_list, created_at)
                VALUES (@name, @enabled, @exclusive, @channelId, @messageId, @manageEmbed, @title, @description, @color, @showList, @createdAt)
            `).run({ ...this.params(input), channelId: source.channelId, messageId, manageEmbed: source.type === 'new' ? 1 : 0, createdAt: Date.now() });
            const panelId = Number(res.lastInsertRowid);
            this.saveEntries(panelId, input.entries);
            return panelId;
        })();

        let warnings: string[];
        if (source.type === 'new') {
            try {
                await this.publishMessage(id, source.channelId);
                warnings = await this.sync(id);
            } catch (err) {
                warnings = [(err as Error).message];
            }
        } else {
            warnings = await this.sync(id);
        }
        publish('reactions:changed', { id });
        logger.info(`✅ Roles por reacción "${input.name}" creados (${input.entries.length} reacciones)`);
        return { panel: this.require(id), warnings };
    }

    async update(id: number, raw: PanelInput): Promise<SaveResult> {
        this.require(id);
        const input = this.prepare(raw);
        this.db.transaction(() => {
            this.db.prepare(`
                UPDATE reaction_panels SET name=@name, enabled=@enabled, exclusive=@exclusive, title=@title,
                    description=@description, color=@color, show_list=@showList
                WHERE id=@id
            `).run({ ...this.params(input), id });
            this.saveEntries(id, input.entries);
        })();
        const warnings = await this.sync(id);
        publish('reactions:changed', { id });
        return { panel: this.require(id), warnings };
    }

    /** Pausa o reanuda sin tocar el mensaje. */
    setEnabled(id: number, enabled: boolean): ReactionPanel {
        this.require(id);
        this.db.prepare('UPDATE reaction_panels SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
        publish('reactions:changed', { id });
        return this.require(id);
    }

    /** Borra la configuración. Los roles que ya tiene la gente NO se tocan. */
    async delete(id: number, deleteMessage: boolean): Promise<void> {
        const p = this.require(id);
        if (deleteMessage && p.manageEmbed && p.channelId && p.messageId) {
            const message = await this.fetchMessage(p.channelId, p.messageId);
            await message?.delete().catch(err => logger.warn(`No se pudo borrar el mensaje de "${p.name}": ${(err as Error).message}`));
        }
        this.db.prepare('DELETE FROM reaction_panels WHERE id = ?').run(id);
        publish('reactions:changed', { id });
    }

    // ────────────────────────── Discord ──────────────────────────

    private async fetchMessage(channelId: string, messageId: string): Promise<Message | null> {
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('messages' in channel)) return null;
        return (await channel.messages.fetch(messageId).catch(() => null)) as Message | null;
    }

    buildEmbed(p: Pick<ReactionPanel, 'name' | 'title' | 'description' | 'color' | 'showList' | 'exclusive' | 'entries'>): EmbedBuilder {
        const embed = new EmbedBuilder().setTitle((p.title || p.name).slice(0, 256));
        try { embed.setColor(p.color as `#${string}`); } catch { embed.setColor(0x5865f2); }
        let desc = p.description.trim();
        if (p.showList && p.entries.length) {
            const lines = p.entries.map(e => `${e.emoji} → <@&${e.roleId}>${e.label ? ` — ${e.label}` : ''}${LIST_SUFFIX[e.behavior]}`);
            desc = [desc, lines.join('\n')].filter(Boolean).join('\n\n');
        }
        if (desc) embed.setDescription(desc.slice(0, 4096));
        if (p.exclusive) embed.setFooter({ text: 'Solo puedes tener uno de estos roles a la vez.' });
        return embed;
    }

    /** Publica el embed en un canal (o en otro canal) y lo enlaza. Las reacciones las pone sync(). */
    async publishMessage(id: number, channelId: string): Promise<ReactionPanel> {
        const p = this.require(id);
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('send' in channel)) throw new HttpError(400, 'Ese canal no admite mensajes.');
        const sent = await (channel as { send: (o: unknown) => Promise<{ id: string }> })
            .send({ embeds: [this.buildEmbed(p)] })
            .catch(err => { throw new HttpError(400, `No se pudo publicar en el canal: ${(err as Error).message}`); });
        this.db.prepare('UPDATE reaction_panels SET channel_id = ?, message_id = ?, manage_embed = 1 WHERE id = ?').run(channelId, sent.id, id);
        return this.require(id);
    }

    async republish(id: number, channelId: string): Promise<SaveResult> {
        await this.publishMessage(id, channelId);
        const warnings = await this.sync(id);
        publish('reactions:changed', { id });
        return { panel: this.require(id), warnings };
    }

    /**
     * Deja el mensaje como toca: embed actualizado (si es del bot) y las reacciones del bot puestas.
     * Nunca quita reacciones de los usuarios ni sus roles.
     */
    async sync(id: number): Promise<string[]> {
        const p = this.require(id);
        if (!p.channelId || !p.messageId) return ['Este mensaje de roles no está publicado en ningún canal.'];
        const message = await this.fetchMessage(p.channelId, p.messageId);
        if (!message) return ['El mensaje ya no existe en Discord: publícalo de nuevo.'];

        const warnings: string[] = [];
        if (p.manageEmbed) {
            await message.edit({ embeds: [this.buildEmbed(p)] }).catch(err => warnings.push(`No se pudo editar el mensaje: ${(err as Error).message}`));
        }

        const me = this.client.user?.id;
        const emojis = [...new Set(p.entries.map(e => e.emoji))];
        for (const emoji of emojis) {
            const existing = message.reactions?.cache.find(r => emojiMatches(emoji, r.emoji));
            if (existing?.me) continue;
            await message.react(emoji).catch(err => warnings.push(`No se pudo reaccionar con ${emoji}: ${(err as Error).message}`));
        }
        // Quita solo las reacciones del propio bot que ya no se usan.
        if (me) {
            for (const r of message.reactions?.cache.values() ?? []) {
                if (r.me && !emojis.some(e => emojiMatches(e, r.emoji))) await r.users.remove(me).catch(() => undefined);
            }
        }
        for (const w of warnings) logger.warn(`"${p.name}": ${w}`);
        return warnings;
    }

    /** Los mensajes antiguos solo guardaban el nombre del emoji personalizado: se completa con su ID. */
    private upgradeLegacyEmojis(): void {
        const guild = this.guild();
        if (!guild) return;
        const rows = this.db.prepare('SELECT id, emoji FROM reaction_roles').all() as Array<{ id: number; emoji: string }>;
        const upd = this.db.prepare('UPDATE reaction_roles SET emoji = ? WHERE id = ?');
        for (const r of rows) {
            if (!/^\w{2,32}$/.test(r.emoji)) continue;
            const found = guild.emojis.cache.find(e => e.name === r.emoji);
            if (found) upd.run(found.toString(), r.id);
        }
    }

    // ────────────────────────── Eventos ──────────────────────────

    start(): void {
        this.active = true;
        try { this.upgradeLegacyEmojis(); } catch (err) { logger.error('No se pudieron actualizar los emojis antiguos', err); }
        // Precarga los mensajes para que discord.js tenga sus reacciones en caché.
        void Promise.all(this.list().filter(p => p.channelId && p.messageId).map(p =>
            this.fetchMessage(p.channelId!, p.messageId!).then(m => { if (!m) logger.warn(`El mensaje de "${p.name}" ya no existe en Discord`); })
        )).then(() => logger.info('✅ Mensajes de roles por reacción precargados'));
    }

    stop(): void {
        this.active = false;
        this.suppressed.clear();
    }

    private suppress(key: string): void {
        this.suppressed.add(key);
        setTimeout(() => this.suppressed.delete(key), 15_000).unref?.();
    }

    async handle(kind: 'add' | 'remove', reaction: AnyReaction, user: User | PartialUser): Promise<void> {
        if (!this.active || user.bot) return;
        const message = reaction.message;
        const key = reactionKey(message.id, reaction.emoji, user.id);
        if (kind === 'remove' && this.suppressed.delete(key)) return;

        const panel = this.byMessage(message.id);
        if (!panel || !panel.enabled) return;
        const matched = panel.entries.filter(e => emojiMatches(e.emoji, reaction.emoji));
        if (!matched.length) return;

        const guild = message.guild ?? (message.guildId ? this.client.guilds.cache.get(message.guildId) : undefined);
        const member = await guild?.members.fetch(user.id).catch(() => null);
        if (!member) return;

        let clearReaction = false;
        for (const entry of matched) {
            const action = RULES[entry.behavior][kind];
            if (entry.behavior === 'click' && kind === 'add') clearReaction = true;
            if (!action) continue;
            const has = member.roles.cache.has(entry.roleId);
            const give = action === 'give' || (action === 'flip' && !has);
            if (give) {
                if (panel.exclusive && GIVES_ON_ADD.includes(entry.behavior)) await this.dropOthers(panel, entry, member, message);
                if (!has) await this.setRole(member, entry.roleId, true, panel);
            } else if (has) {
                await this.setRole(member, entry.roleId, false, panel);
            }
        }

        if (clearReaction) {
            this.suppress(key);
            await reaction.users.remove(user.id).catch(err => {
                this.suppressed.delete(key);
                logger.warn(`No se pudo quitar la reacción de ${member.user.username} (¿falta "Gestionar mensajes"?): ${(err as Error).message}`);
            });
        }
    }

    /** Modo exclusivo: quita los demás roles del mensaje y sus reacciones. */
    private async dropOthers(panel: ReactionPanel, keep: ReactionEntry, member: GuildMember, message: Message | PartialMessage): Promise<void> {
        const others = panel.entries.filter(e => e.emoji !== keep.emoji && GIVES_ON_ADD.includes(e.behavior));
        if (!others.length) return;
        for (const e of others) {
            if (e.roleId !== keep.roleId && member.roles.cache.has(e.roleId)) await this.setRole(member, e.roleId, false, panel);
        }
        const full = message.partial ? await message.fetch().catch(() => null) : message;
        for (const e of others) {
            if (e.behavior === 'click') continue;
            const r = full?.reactions.cache.find(x => emojiMatches(e.emoji, x.emoji));
            if (!r) continue;
            const key = reactionKey(message.id, r.emoji, member.id);
            this.suppress(key);
            await r.users.remove(member.id).catch(() => this.suppressed.delete(key));
        }
    }

    private async setRole(member: GuildMember, roleId: string, give: boolean, panel: ReactionPanel): Promise<void> {
        const roleName = this.guild()?.roles.cache.get(roleId)?.name ?? roleId;
        try {
            if (give) await member.roles.add(roleId, `Rol por reacción: ${panel.name}`);
            else await member.roles.remove(roleId, `Rol por reacción: ${panel.name}`);
            logger.info(`${give ? '➕' : '➖'} Rol ${roleName} ${give ? 'asignado a' : 'quitado a'} ${member.user.username} ("${panel.name}")`);
            publish('reactions:activity', { panelId: panel.id, userId: member.id, roleId, action: give ? 'add' : 'remove' });
        } catch (err) {
            logger.warn(`No se pudo ${give ? 'dar' : 'quitar'} el rol ${roleName} a ${member.user.username}: ${(err as Error).message}`);
        }
    }

    /** Emojis personalizados del servidor (para el selector del panel). */
    customEmojis(): Array<{ id: string; name: string; animated: boolean; value: string; url: string }> {
        const guild = this.guild();
        if (!guild) return [];
        return [...guild.emojis.cache.values()].map(e => ({
            id: e.id, name: e.name ?? '', animated: !!e.animated, value: e.toString(), url: e.imageURL({ size: 64 }),
        }));
    }
}
