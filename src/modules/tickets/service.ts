import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type Client,
    type Guild,
    type GuildMember,
    type Interaction,
    type Message,
    type ModalSubmitInteraction,
    type TextChannel,
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../../core/db';
import { UPLOADS_DIR, getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { registerFile, toFileInfo, getFiles } from '../../core/files';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { MessagesService } from '../messages/service';

const logger = new Logger('Tickets');
const CONFIG_KEY = 'tickets.config';

// ────────────────────────── Tipos ──────────────────────────

export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export type ButtonStyleName = typeof BUTTON_STYLES[number];
const STYLE: Record<ButtonStyleName, ButtonStyle> = {
    primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};

export interface TicketQuestion { label: string; placeholder: string; long: boolean; required: boolean }

export interface TicketType {
    id: number;
    label: string;
    emoji: string;
    style: ButtonStyleName;
    categoryId: string | null;
    supportRoleIds: string[];
    nameTemplate: string;
    welcome: string;
    questions: TicketQuestion[];
    maxOpen: number;
}

export interface TicketPanel {
    id: number;
    name: string;
    channelId: string | null;
    messageId: string | null;
    title: string;
    description: string;
    color: string;
    createdAt: number;
    types: TicketType[];
}

export type TypeInput = Omit<TicketType, 'id'> & { id?: number };
export type PanelInput = Pick<TicketPanel, 'name' | 'title' | 'description' | 'color'> & { types: TypeInput[] };

export interface Ticket {
    id: number;
    number: number;
    typeId: number | null;
    typeLabel: string;
    userId: string;
    userTag: string | null;
    userAvatar: string | null;
    channelId: string | null;
    status: 'open' | 'closed';
    answers: Array<{ question: string; answer: string }>;
    claimedById: string | null;
    claimedByName: string | null;
    closeReason: string | null;
    closedById: string | null;
    closedByName: string | null;
    createdAt: number;
    closedAt: number | null;
    lastMessageAt: number;
    /** Quién escribió lo último: 'user' = esperando respuesta del staff. */
    lastKind: TicketMessage['kind'] | null;
    messageCount: number;
}

export interface TicketMessage {
    id: number;
    ticketId: number;
    authorId: string | null;
    authorName: string | null;
    authorAvatar: string | null;
    kind: 'user' | 'staff' | 'panel' | 'system';
    content: string;
    attachments: Array<{ name: string; url: string }>;
    createdAt: number;
}

export interface TicketsConfig {
    /** Canal donde se publica un resumen (y la transcripción) de cada ticket cerrado. */
    logChannelId: string | null;
    /** Borrar el canal al cerrar (si no, se bloquea y se renombra). */
    deleteOnClose: boolean;
    closeDelaySec: number;
    /** Mandar al usuario un MD con el resumen al cerrar. */
    dmOnClose: boolean;
    /** Adjuntar la transcripción (HTML) al MD y al registro. */
    attachTranscript: boolean;
}

const DEFAULT_CONFIG: TicketsConfig = { logChannelId: null, deleteOnClose: true, closeDelaySec: 10, dmOnClose: true, attachTranscript: true };

export const DEFAULT_WELCOME = 'Hola {mention}, gracias por abrir un ticket.\nEl equipo te atenderá lo antes posible; mientras tanto, cuéntanos con detalle qué necesitas.';

interface PanelRow { id: number; name: string; channel_id: string | null; message_id: string | null; title: string; description: string; color: string; created_at: number }
interface TypeRow {
    id: number; panel_id: number; label: string; emoji: string; style: ButtonStyleName; category_id: string | null; support_role_ids: string;
    name_template: string; welcome: string; questions: string; max_open: number; position: number;
}
interface TicketRow {
    id: number; number: number; type_id: number | null; type_label: string; user_id: string; user_tag: string | null; user_avatar: string | null;
    channel_id: string | null; status: 'open' | 'closed'; answers: string; claimed_by_id: string | null; claimed_by_name: string | null;
    close_reason: string | null; closed_by_id: string | null; closed_by_name: string | null; created_at: number; closed_at: number | null;
    last_message_at: number; last_kind?: TicketMessage['kind'] | null; message_count?: number;
}
interface MessageRow {
    id: number; ticket_id: number; discord_id: string | null; author_id: string | null; author_name: string | null; author_avatar: string | null;
    kind: TicketMessage['kind']; content: string; attachments: string; created_at: number;
}

const toType = (r: TypeRow): TicketType => ({
    id: r.id, label: r.label, emoji: r.emoji, style: r.style, categoryId: r.category_id, supportRoleIds: parseJson(r.support_role_ids, []),
    nameTemplate: r.name_template, welcome: r.welcome, questions: parseJson(r.questions, []), maxOpen: r.max_open,
});
const toTicket = (r: TicketRow): Ticket => ({
    id: r.id, number: r.number, typeId: r.type_id, typeLabel: r.type_label, userId: r.user_id, userTag: r.user_tag, userAvatar: r.user_avatar,
    channelId: r.channel_id, status: r.status, answers: parseJson(r.answers, []), claimedById: r.claimed_by_id, claimedByName: r.claimed_by_name,
    closeReason: r.close_reason, closedById: r.closed_by_id, closedByName: r.closed_by_name, createdAt: r.created_at, closedAt: r.closed_at,
    lastMessageAt: r.last_message_at, lastKind: r.last_kind ?? null, messageCount: r.message_count ?? 0,
});
const toMessage = (r: MessageRow): TicketMessage => ({
    id: r.id, ticketId: r.ticket_id, authorId: r.author_id, authorName: r.author_name, authorAvatar: r.author_avatar, kind: r.kind,
    content: r.content, attachments: parseJson(r.attachments, []), createdAt: r.created_at,
});

const TICKET_SELECT = `
    SELECT t.*,
        (SELECT kind FROM ticket_messages m WHERE m.ticket_id = t.id AND m.kind != 'system' ORDER BY m.id DESC LIMIT 1) AS last_kind,
        (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.kind != 'system') AS message_count
    FROM tickets t`;

export const pad = (n: number) => String(n).padStart(4, '0');
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral } as const);

/** Nombre de canal válido para Discord a partir de la plantilla. */
export function channelName(template: string, vars: { number: number; username: string; type: string }): string {
    const name = (template || 'ticket-{number}')
        .replaceAll('{number}', pad(vars.number))
        .replaceAll('{username}', vars.username)
        .replaceAll('{type}', vars.type)
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\-_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90);
    return name || `ticket-${pad(vars.number)}`;
}

export class TicketsService {
    active = false;
    /** Canales que borra el propio bot al cerrar: su evento channelDelete no debe hacer nada. */
    private readonly deleting = new Set<string>();

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

    getConfig(): TicketsConfig {
        return { ...DEFAULT_CONFIG, ...parseJson<Partial<TicketsConfig>>(getSetting(this.db, CONFIG_KEY, ''), {}) };
    }

    setConfig(cfg: TicketsConfig): TicketsConfig {
        setSetting(this.db, CONFIG_KEY, JSON.stringify(cfg));
        publish('tickets:changed', {});
        return this.getConfig();
    }

    // ────────────────────────── Paneles ──────────────────────────

    private toPanel(r: PanelRow): TicketPanel {
        const types = (this.db.prepare('SELECT * FROM ticket_types WHERE panel_id = ? ORDER BY position, id').all(r.id) as TypeRow[]).map(toType);
        return { id: r.id, name: r.name, channelId: r.channel_id, messageId: r.message_id, title: r.title, description: r.description, color: r.color, createdAt: r.created_at, types };
    }

    listPanels(): TicketPanel[] {
        return (this.db.prepare('SELECT * FROM ticket_panels ORDER BY id').all() as PanelRow[]).map(r => this.toPanel(r));
    }

    requirePanel(id: number): TicketPanel {
        const r = this.db.prepare('SELECT * FROM ticket_panels WHERE id = ?').get(id) as PanelRow | undefined;
        if (!r) throw new HttpError(404, 'Panel de tickets no encontrado');
        return this.toPanel(r);
    }

    getType(id: number): (TicketType & { panelId: number }) | null {
        const r = this.db.prepare('SELECT * FROM ticket_types WHERE id = ?').get(id) as TypeRow | undefined;
        return r ? { ...toType(r), panelId: r.panel_id } : null;
    }

    private validate(input: PanelInput): void {
        if (!input.types.length) throw new HttpError(400, 'Añade al menos un botón (tipo de ticket).');
        if (input.types.length > 25) throw new HttpError(400, 'Máximo 25 botones por panel.');
        const guild = this.client.guilds.cache.get(env.guildId);
        for (const t of input.types) {
            if (t.questions.length > 5) throw new HttpError(400, `"${t.label}": máximo 5 preguntas (límite de Discord).`);
            if (!guild) continue;
            if (t.categoryId) {
                const cat = guild.channels.cache.get(t.categoryId);
                if (!cat || cat.type !== ChannelType.GuildCategory) throw new HttpError(400, `"${t.label}": la categoría ya no existe.`);
            }
            if (t.supportRoleIds.some(id => !guild.roles.cache.has(id))) throw new HttpError(400, `"${t.label}": alguno de los roles de soporte ya no existe.`);
        }
    }

    /**
     * Guarda los tipos conservando los IDs de los que ya existían (los botones publicados y
     * los tickets abiertos siguen apuntando a ellos); los que faltan se borran.
     */
    private saveTypes(panelId: number, types: TypeInput[]): void {
        const existing = new Set((this.db.prepare('SELECT id FROM ticket_types WHERE panel_id = ?').all(panelId) as Array<{ id: number }>).map(r => r.id));
        const keep = new Set<number>();
        const upd = this.db.prepare(`
            UPDATE ticket_types SET label=@label, emoji=@emoji, style=@style, category_id=@categoryId, support_role_ids=@roles,
                name_template=@nameTemplate, welcome=@welcome, questions=@questions, max_open=@maxOpen, position=@position
            WHERE id=@id AND panel_id=@panelId`);
        const ins = this.db.prepare(`
            INSERT INTO ticket_types (panel_id, label, emoji, style, category_id, support_role_ids, name_template, welcome, questions, max_open, position)
            VALUES (@panelId, @label, @emoji, @style, @categoryId, @roles, @nameTemplate, @welcome, @questions, @maxOpen, @position)`);
        types.forEach((t, position) => {
            const p = { ...t, panelId, position, roles: JSON.stringify(t.supportRoleIds), questions: JSON.stringify(t.questions) };
            if (t.id && existing.has(t.id)) { upd.run({ ...p, id: t.id }); keep.add(t.id); }
            else ins.run(p);
        });
        for (const id of existing) if (!keep.has(id)) this.db.prepare('DELETE FROM ticket_types WHERE id = ?').run(id);
    }

    async createPanel(input: PanelInput, channelId: string | null): Promise<{ panel: TicketPanel; warnings: string[] }> {
        this.validate(input);
        const id = this.db.transaction(() => {
            const res = this.db.prepare('INSERT INTO ticket_panels (name, title, description, color, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(input.name, input.title, input.description, input.color, Date.now());
            const panelId = Number(res.lastInsertRowid);
            this.saveTypes(panelId, input.types);
            return panelId;
        })();
        const warnings: string[] = [];
        if (channelId) await this.publishPanel(id, channelId).catch(err => warnings.push((err as Error).message));
        publish('tickets:changed', {});
        return { panel: this.requirePanel(id), warnings };
    }

    async updatePanel(id: number, input: PanelInput): Promise<{ panel: TicketPanel; warnings: string[] }> {
        this.requirePanel(id);
        this.validate(input);
        this.db.transaction(() => {
            this.db.prepare('UPDATE ticket_panels SET name = ?, title = ?, description = ?, color = ? WHERE id = ?')
                .run(input.name, input.title, input.description, input.color, id);
            this.saveTypes(id, input.types);
        })();
        const warnings: string[] = [];
        const panel = this.requirePanel(id);
        if (panel.channelId && panel.messageId) {
            const msg = await this.fetchMessage(panel.channelId, panel.messageId);
            if (!msg) warnings.push('El mensaje del panel ya no existe en Discord: publícalo de nuevo.');
            else await msg.edit(this.panelMessage(panel)).catch(err => warnings.push(`No se pudo actualizar el mensaje: ${(err as Error).message}`));
        }
        publish('tickets:changed', {});
        return { panel, warnings };
    }

    async deletePanel(id: number, deleteMessage: boolean): Promise<void> {
        const p = this.requirePanel(id);
        if (deleteMessage && p.channelId && p.messageId) {
            await (await this.fetchMessage(p.channelId, p.messageId))?.delete().catch(() => undefined);
        }
        this.db.prepare('DELETE FROM ticket_panels WHERE id = ?').run(id);
        publish('tickets:changed', {});
    }

    panelMessage(p: TicketPanel) {
        const embed = new EmbedBuilder().setTitle(p.title.slice(0, 256) || 'Tickets');
        try { embed.setColor(p.color as `#${string}`); } catch { embed.setColor(0x5865f2); }
        if (p.description.trim()) embed.setDescription(p.description.slice(0, 4096));
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        p.types.forEach((t, i) => {
            if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
            const b = new ButtonBuilder().setCustomId(`tk:open:${t.id}`).setLabel(t.label.slice(0, 80)).setStyle(STYLE[t.style]);
            if (t.emoji) b.setEmoji(t.emoji);
            rows[rows.length - 1].addComponents(b);
        });
        return { embeds: [embed], components: rows };
    }

    async publishPanel(id: number, channelId: string): Promise<TicketPanel> {
        const p = this.requirePanel(id);
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('send' in channel)) throw new HttpError(400, 'Ese canal no admite mensajes.');
        const sent = await (channel as TextChannel).send(this.panelMessage(p))
            .catch(err => { throw new HttpError(400, `No se pudo publicar el panel: ${(err as Error).message}`); });
        this.db.prepare('UPDATE ticket_panels SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, sent.id, id);
        publish('tickets:changed', {});
        return this.requirePanel(id);
    }

    private async fetchMessage(channelId: string, messageId: string): Promise<Message | null> {
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('messages' in channel)) return null;
        return (await channel.messages.fetch(messageId).catch(() => null)) as Message | null;
    }

    // ────────────────────────── Tickets ──────────────────────────

    list(q: { status?: 'open' | 'closed'; userId?: string; search?: string; limit?: number } = {}): Ticket[] {
        const where: string[] = [];
        const params: Record<string, unknown> = { limit: Math.min(q.limit ?? 200, 500) };
        if (q.status) { where.push('t.status = @status'); params.status = q.status; }
        if (q.userId) { where.push('t.user_id = @userId'); params.userId = q.userId; }
        if (q.search) {
            where.push("(t.user_tag LIKE @s ESCAPE '\\' OR t.type_label LIKE @s ESCAPE '\\' OR CAST(t.number AS TEXT) = @n)");
            params.s = `%${q.search.replace(/[\\%_]/g, m => `\\${m}`)}%`;
            params.n = q.search.replace(/^#?0*/, '');
        }
        const sql = `${TICKET_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.status = 'open' DESC, t.last_message_at DESC LIMIT @limit`;
        return (this.db.prepare(sql).all(params) as TicketRow[]).map(toTicket);
    }

    get(id: number): Ticket | null {
        const r = this.db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id) as TicketRow | undefined;
        return r ? toTicket(r) : null;
    }

    require(id: number): Ticket {
        const t = this.get(id);
        if (!t) throw new HttpError(404, 'Ticket no encontrado');
        return t;
    }

    private byChannel(channelId: string): Ticket | null {
        const r = this.db.prepare(`${TICKET_SELECT} WHERE t.channel_id = ? AND t.status = 'open'`).get(channelId) as TicketRow | undefined;
        return r ? toTicket(r) : null;
    }

    messagesOf(id: number): TicketMessage[] {
        return (this.db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(id) as MessageRow[]).map(toMessage);
    }

    counts(): { open: number; waiting: number } {
        const open = this.list({ status: 'open', limit: 500 });
        return { open: open.length, waiting: open.filter(t => t.lastKind === 'user').length };
    }

    private addMessage(ticketId: number, m: Omit<TicketMessage, 'id' | 'ticketId' | 'createdAt'> & { discordId?: string | null; createdAt?: number }): TicketMessage {
        const createdAt = m.createdAt ?? Date.now();
        const res = this.db.prepare(`
            INSERT INTO ticket_messages (ticket_id, discord_id, author_id, author_name, author_avatar, kind, content, attachments, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ticketId, m.discordId ?? null, m.authorId, m.authorName, m.authorAvatar, m.kind, m.content, JSON.stringify(m.attachments), createdAt);
        if (m.kind !== 'system') this.db.prepare('UPDATE tickets SET last_message_at = ? WHERE id = ?').run(createdAt, ticketId);
        const msg = toMessage(this.db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(res.lastInsertRowid) as MessageRow);
        publish('tickets:message', msg);
        return msg;
    }

    /** ¿Es staff para este ticket? (rol de soporte del tipo o permiso de gestionar canales) */
    isStaff(member: GuildMember, typeId: number | null): boolean {
        if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
        const type = typeId ? this.getType(typeId) : null;
        return !!type?.supportRoleIds.some(r => member.roles.cache.has(r));
    }

    /** Crea el canal del ticket y lo registra. */
    async open(member: GuildMember, typeId: number, answers: Ticket['answers']): Promise<Ticket> {
        const type = this.getType(typeId);
        if (!type) throw new HttpError(404, 'Este tipo de ticket ya no existe.');
        if (type.maxOpen > 0) {
            const n = (this.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND type_id = ? AND status = 'open'").get(member.id, typeId) as { n: number }).n;
            if (n >= type.maxOpen) {
                const open = this.list({ status: 'open', userId: member.id }).find(t => t.typeId === typeId);
                throw new HttpError(400, `Ya tienes ${type.maxOpen === 1 ? 'un ticket abierto' : `${n} tickets abiertos`} de este tipo${open?.channelId ? `: <#${open.channelId}>` : ''}.`);
            }
        }

        const now = Date.now();
        const ticketId = this.db.transaction(() => {
            const number = ((this.db.prepare('SELECT MAX(number) AS n FROM tickets').get() as { n: number | null }).n ?? 0) + 1;
            return Number(this.db.prepare(`
                INSERT INTO tickets (number, type_id, type_label, user_id, user_tag, user_avatar, answers, created_at, last_message_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(number, typeId, type.label, member.id, member.user.username, member.user.displayAvatarURL({ size: 64 }), JSON.stringify(answers), now, now).lastInsertRowid);
        })();
        const ticket = this.require(ticketId);

        const guild = member.guild;
        const perms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
        let channel: TextChannel;
        try {
            channel = await guild.channels.create({
                name: channelName(type.nameTemplate, { number: ticket.number, username: member.user.username, type: type.label }),
                type: ChannelType.GuildText,
                parent: type.categoryId ?? undefined,
                topic: `Ticket #${pad(ticket.number)} · ${type.label} · abierto por ${member.user.username}`,
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: member.id, allow: perms },
                    ...type.supportRoleIds.map(id => ({ id, allow: [...perms, PermissionFlagsBits.ManageMessages] })),
                    { id: this.client.user!.id, allow: [...perms, PermissionFlagsBits.ManageChannels] },
                ],
                reason: `Ticket #${pad(ticket.number)} de ${member.user.username}`,
            }) as TextChannel;
        } catch (err) {
            this.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
            logger.error(`No se pudo crear el canal del ticket de ${member.user.username}`, err);
            throw new HttpError(400, 'No se pudo crear el canal del ticket (¿el bot tiene permiso de "Gestionar canales" en esa categoría?).');
        }
        this.db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channel.id, ticketId);

        const welcome = (type.welcome || DEFAULT_WELCOME)
            .replaceAll('{mention}', `<@${member.id}>`).replaceAll('{user}', member.displayName).replaceAll('{username}', member.user.username)
            .replaceAll('{number}', pad(ticket.number)).replaceAll('{type}', type.label);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${type.emoji ? `${type.emoji} ` : ''}${type.label} · Ticket #${pad(ticket.number)}`.slice(0, 256))
            .setDescription(welcome.slice(0, 4096)).setTimestamp();
        for (const a of answers) embed.addFields({ name: a.question.slice(0, 256), value: (a.answer || '—').slice(0, 1024) });
        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`tk:close:${ticketId}`).setLabel('Cerrar').setEmoji('🔒').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`tk:closer:${ticketId}`).setLabel('Cerrar con motivo').setEmoji('📝').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`tk:claim:${ticketId}`).setLabel('Atender').setEmoji('🙋').setStyle(ButtonStyle.Success),
        );
        await channel.send({
            content: [`<@${member.id}>`, ...type.supportRoleIds.map(r => `<@&${r}>`)].join(' '),
            embeds: [embed], components: [buttons],
            allowedMentions: { users: [member.id], roles: type.supportRoleIds },
        }).catch(err => logger.warn(`No se pudo enviar el mensaje inicial del ticket: ${(err as Error).message}`));

        this.addMessage(ticketId, {
            authorId: member.id, authorName: member.user.username, authorAvatar: null, kind: 'system', attachments: [],
            content: `Ticket abierto (${type.label})${answers.length ? `\n${answers.map(a => `• ${a.question}: ${a.answer || '—'}`).join('\n')}` : ''}`,
        });
        logger.info(`🎫 Ticket #${pad(ticket.number)} (${type.label}) abierto por ${member.user.username}`);
        publish('tickets:changed', { id: ticketId });
        return this.require(ticketId);
    }

    async claim(id: number, by: { id: string; name: string }): Promise<Ticket> {
        const t = this.require(id);
        if (t.status !== 'open') throw new HttpError(400, 'El ticket ya está cerrado.');
        this.db.prepare('UPDATE tickets SET claimed_by_id = ?, claimed_by_name = ? WHERE id = ?').run(by.id, by.name, id);
        this.addMessage(id, { authorId: by.id, authorName: by.name, authorAvatar: null, kind: 'system', content: `${by.name} atiende este ticket`, attachments: [] });
        if (t.channelId) {
            const channel = await this.client.channels.fetch(t.channelId).catch(() => null);
            if (channel && 'send' in channel) {
                await (channel as TextChannel).send({ embeds: [new EmbedBuilder().setColor(0x3ba55d).setDescription(`🙋 **${by.name}** atenderá este ticket.`)] }).catch(() => undefined);
            }
        }
        publish('tickets:changed', { id });
        return this.require(id);
    }

    /** Responde desde el panel: el mensaje sale en el canal del ticket, enviado por el bot. */
    async reply(id: number, by: { id: string; name: string }, content: string, fileIds: string[]): Promise<TicketMessage> {
        const t = this.require(id);
        if (t.status !== 'open' || !t.channelId) throw new HttpError(400, 'El ticket está cerrado.');
        const text = content.trim() ? `**${by.name}:** ${content.trim()}` : '';
        const res = await this.messages.sendToChannel(t.channelId, { content: text, fileIds }, { source: 'ticket', sourceRef: String(id) });
        if (res.status === 'failed') throw new HttpError(400, `No se pudo enviar: ${res.error}`);
        return this.addMessage(id, {
            discordId: res.discordId, authorId: by.id, authorName: by.name, authorAvatar: null, kind: 'panel',
            content: content.trim(), attachments: getFiles(this.db, fileIds).map(f => ({ name: f.name, url: toFileInfo(f).url })),
        });
    }

    async close(id: number, by: { id: string | null; name: string }, reason: string | null, opts: { channelGone?: boolean } = {}): Promise<Ticket> {
        const t = this.require(id);
        if (t.status === 'closed') throw new HttpError(400, 'El ticket ya está cerrado.');
        const cfg = this.getConfig();
        const clean = reason?.trim() || null;
        this.db.prepare("UPDATE tickets SET status = 'closed', close_reason = ?, closed_by_id = ?, closed_by_name = ?, closed_at = ? WHERE id = ?")
            .run(clean, by.id, by.name, Date.now(), id);
        this.addMessage(id, { authorId: by.id, authorName: by.name, authorAvatar: null, kind: 'system', attachments: [], content: `Ticket cerrado por ${by.name}${clean ? `: ${clean}` : ''}` });
        const closed = this.require(id);
        logger.info(`🔒 Ticket #${pad(t.number)} cerrado por ${by.name}${clean ? `: ${clean}` : ''}`);

        const transcriptId = cfg.attachTranscript ? this.saveTranscript(closed) : null;
        const fileIds = transcriptId ? [transcriptId] : [];
        const summary = {
            color: '#ED4245',
            fields: `**Tipo:** ${t.typeLabel}\n**Cerrado por:** ${by.name}\n**Motivo:** ${clean ?? 'Sin motivo'}`,
        };

        // Aviso en el propio canal, MD al usuario y registro.
        if (!opts.channelGone && t.channelId) {
            const channel = await this.client.channels.fetch(t.channelId).catch(() => null) as TextChannel | null;
            if (channel && 'send' in channel) {
                await channel.send({
                    embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Ticket cerrado')
                        .setDescription(`Cerrado por **${by.name}**${clean ? `\n**Motivo:** ${clean}` : ''}${cfg.deleteOnClose ? `\n\nEste canal se borrará en ${cfg.closeDelaySec} s.` : ''}`.slice(0, 4096))],
                }).catch(() => undefined);
                if (cfg.deleteOnClose) {
                    this.deleting.add(channel.id);
                    setTimeout(() => {
                        channel.delete(`Ticket #${pad(t.number)} cerrado`).catch(err => { this.deleting.delete(channel.id); logger.warn(`No se pudo borrar el canal del ticket: ${(err as Error).message}`); });
                    }, cfg.closeDelaySec * 1000).unref?.();
                } else {
                    await channel.permissionOverwrites.edit(t.userId, { SendMessages: false }).catch(() => undefined);
                    await channel.setName(`cerrado-${pad(t.number)}`).catch(() => undefined);
                }
            }
        }
        if (cfg.dmOnClose) {
            await this.messages.sendToUser(t.userId, {
                embed: { title: `🎫 Tu ticket #${pad(t.number)} se ha cerrado`, description: `${summary.fields}\n\nGracias por contactar con nosotros. Si necesitas algo más, abre otro ticket.`, color: summary.color, timestamp: true },
                fileIds,
            }, { source: 'ticket', sourceRef: String(id) }).catch(err => logger.warn(`No se pudo avisar por MD del cierre: ${(err as Error).message}`));
        }
        if (cfg.logChannelId) {
            await this.messages.sendToChannel(cfg.logChannelId, {
                embed: {
                    title: `🔒 Ticket #${pad(t.number)} cerrado`,
                    description: `**Usuario:** <@${t.userId}> (${t.userTag ?? t.userId})\n${summary.fields}${t.claimedByName ? `\n**Atendido por:** ${t.claimedByName}` : ''}\n**Mensajes:** ${closed.messageCount}`,
                    color: summary.color, timestamp: true,
                },
                fileIds,
            }, { source: 'ticket', sourceRef: String(id) }).catch(err => logger.warn(`No se pudo publicar el cierre en el registro: ${(err as Error).message}`));
        }

        publish('tickets:changed', { id });
        return closed;
    }

    deleteTicket(id: number): void {
        const t = this.require(id);
        if (t.status === 'open') throw new HttpError(400, 'Cierra el ticket antes de borrarlo del historial.');
        this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
        publish('tickets:changed', { id });
    }

    // ────────────────────────── Transcripción ──────────────────────────

    transcriptHtml(t: Ticket): string {
        const msgs = this.messagesOf(t.id);
        const fmt = (ts: number) => new Date(ts).toLocaleString('es-ES', { timeZone: env.timezone });
        const KIND: Record<TicketMessage['kind'], string> = { user: 'Usuario', staff: 'Staff', panel: 'Staff (panel)', system: 'Sistema' };
        const rows = msgs.map(m => `
            <div class="msg ${m.kind}">
                <div class="meta"><b>${esc(m.authorName ?? 'Desconocido')}</b> <span class="tag">${KIND[m.kind]}</span> <time>${esc(fmt(m.createdAt))}</time></div>
                ${m.content ? `<div class="text">${esc(m.content)}</div>` : ''}
                ${m.attachments.map(a => `<div class="att">📎 <a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join('')}
            </div>`).join('');
        return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket #${pad(t.number)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;background:#f3f4f7;color:#1b1e27;margin:0;padding:24px}
.wrap{max-width:820px;margin:0 auto}
header{background:#fff;border:1px solid #dde1e9;border-radius:10px;padding:16px 20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 6px} dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0} dt{color:#667085}
.msg{background:#fff;border:1px solid #dde1e9;border-radius:10px;padding:10px 14px;margin-bottom:8px}
.msg.system{background:transparent;border-style:dashed;color:#667085}
.msg.staff,.msg.panel{border-left:4px solid #5865f2}
.meta{font-size:12.5px;color:#667085} .meta b{color:#1b1e27;font-size:14px}
.tag{background:#e9ecf2;border-radius:99px;padding:1px 8px;margin:0 4px}
.text{white-space:pre-wrap;word-wrap:break-word;margin-top:4px}
@media (prefers-color-scheme:dark){body{background:#0e1015;color:#e7e9ef}header,.msg{background:#161921;border-color:#2a303c}.meta b{color:#e7e9ef}.tag{background:#262b37}}
</style></head><body><div class="wrap">
<header><h1>Ticket #${pad(t.number)} · ${esc(t.typeLabel)}</h1><dl>
<dt>Usuario</dt><dd>${esc(t.userTag ?? t.userId)} (${esc(t.userId)})</dd>
<dt>Abierto</dt><dd>${esc(fmt(t.createdAt))}</dd>
${t.closedAt ? `<dt>Cerrado</dt><dd>${esc(fmt(t.closedAt))} por ${esc(t.closedByName ?? '—')}</dd>` : ''}
${t.closeReason ? `<dt>Motivo</dt><dd>${esc(t.closeReason)}</dd>` : ''}
${t.claimedByName ? `<dt>Atendido por</dt><dd>${esc(t.claimedByName)}</dd>` : ''}
</dl></header>${rows}</div></body></html>`;
    }

    private saveTranscript(t: Ticket): string | null {
        try {
            const html = this.transcriptHtml(t);
            const file = path.join(UPLOADS_DIR, `transcript-${t.id}-${Date.now()}.html`);
            fs.writeFileSync(file, html);
            return registerFile(this.db, { name: `ticket-${pad(t.number)}.html`, mime: 'text/html', size: Buffer.byteLength(html), path: file }).id;
        } catch (err) {
            logger.error('No se pudo guardar la transcripción', err);
            return null;
        }
    }

    // ────────────────────────── Eventos de Discord ──────────────────────────

    onMessage(message: Message): void {
        if (!this.active || !message.guildId || message.author.bot) return;
        const t = this.byChannel(message.channelId);
        if (!t) return;
        const isUser = message.author.id === t.userId;
        this.addMessage(t.id, {
            discordId: message.id, authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
            authorAvatar: message.author.displayAvatarURL({ size: 64 }), kind: isUser ? 'user' : 'staff',
            content: message.content, attachments: [...message.attachments.values()].map(a => ({ name: a.name, url: a.url })),
            createdAt: message.createdTimestamp,
        });
    }

    /** Si alguien borra a mano el canal de un ticket abierto, se da por cerrado. */
    async onChannelDelete(channelId: string): Promise<void> {
        if (this.deleting.delete(channelId)) return;
        const t = this.byChannel(channelId);
        if (t) await this.close(t.id, { id: null, name: 'Discord' }, 'El canal se borró a mano', { channelGone: true }).catch(() => undefined);
    }

    async onInteraction(i: Interaction): Promise<void> {
        if (!this.active || (!i.isButton() && !i.isModalSubmit())) return;
        const m = /^tk:(open|form|close|closeok|closer|closereason|claim):(\d+)$/.exec(i.customId);
        if (!m) return;
        const [, action, rawId] = m;
        const id = Number(rawId);
        try {
            if (action === 'open' && i.isButton()) return await this.onOpenButton(i, id);
            if (action === 'form' && i.isModalSubmit()) return await this.onOpenForm(i, id);
            await this.onTicketAction(i as ButtonInteraction | ModalSubmitInteraction, action, id);
        } catch (err) {
            const msg = err instanceof HttpError ? err.message : 'Algo ha fallado. Inténtalo de nuevo o avisa al staff.';
            if (!(err instanceof HttpError)) logger.error('Error en un botón de tickets', err);
            if (i.deferred || i.replied) await i.editReply(msg).catch(() => undefined);
            else await i.reply(ephemeral(msg)).catch(() => undefined);
        }
    }

    private async onOpenButton(i: ButtonInteraction, typeId: number): Promise<void> {
        const type = this.getType(typeId);
        if (!type) return void await i.reply(ephemeral('Este botón ya no está disponible.'));
        if (type.questions.length) {
            const modal = new ModalBuilder().setCustomId(`tk:form:${typeId}`).setTitle(type.label.slice(0, 45));
            type.questions.slice(0, 5).forEach((q, n) => {
                const input = new TextInputBuilder().setCustomId(`q${n}`).setLabel(q.label.slice(0, 45))
                    .setStyle(q.long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(q.required).setMaxLength(q.long ? 1000 : 200);
                if (q.placeholder) input.setPlaceholder(q.placeholder.slice(0, 100));
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
            });
            return void await i.showModal(modal);
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const member = await i.guild!.members.fetch(i.user.id);
        const t = await this.open(member, typeId, []);
        await i.editReply(`✅ Ticket creado: <#${t.channelId}>`);
    }

    private async onOpenForm(i: ModalSubmitInteraction, typeId: number): Promise<void> {
        const type = this.getType(typeId);
        if (!type) return void await i.reply(ephemeral('Este tipo de ticket ya no existe.'));
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const answers = type.questions.slice(0, 5).map((q, n) => {
            let answer = '';
            try { answer = i.fields.getTextInputValue(`q${n}`); } catch { /* opcional y vacía */ }
            return { question: q.label, answer: answer.trim() };
        });
        const member = await i.guild!.members.fetch(i.user.id);
        const t = await this.open(member, typeId, answers);
        await i.editReply(`✅ Ticket creado: <#${t.channelId}>`);
    }

    private async onTicketAction(i: ButtonInteraction | ModalSubmitInteraction, action: string, ticketId: number): Promise<void> {
        const t = this.get(ticketId);
        if (!t || t.status !== 'open') return void await i.reply(ephemeral('Este ticket ya está cerrado.'));
        const member = await i.guild!.members.fetch(i.user.id);
        const staff = this.isStaff(member, t.typeId);
        if (member.id !== t.userId && !staff) return void await i.reply(ephemeral('Solo quien abrió el ticket o el staff pueden hacer esto.'));
        const by = { id: member.id, name: member.displayName };

        if (action === 'close' && i.isButton()) {
            return void await i.reply({
                ...ephemeral('¿Seguro que quieres cerrar el ticket?'),
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`tk:closeok:${ticketId}`).setLabel('Sí, cerrar').setStyle(ButtonStyle.Danger))],
            });
        }
        if (action === 'closer' && i.isButton()) {
            return void await i.showModal(new ModalBuilder().setCustomId(`tk:closereason:${ticketId}`).setTitle('Cerrar ticket')
                .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId('reason').setLabel('Motivo').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500))));
        }
        if (action === 'closeok' || action === 'closereason') {
            const reason = i.isModalSubmit() ? i.fields.getTextInputValue('reason') : null;
            if (i.isButton()) await i.update({ content: '🔒 Cerrando el ticket…', components: [] });
            else await i.deferReply({ flags: MessageFlags.Ephemeral });
            await this.close(ticketId, by, reason);
            if (i.isModalSubmit()) await i.editReply('🔒 Ticket cerrado.');
            return;
        }
        if (action === 'claim') {
            if (!staff) return void await i.reply(ephemeral('Solo el staff puede atender tickets.'));
            if (t.claimedById === member.id) return void await i.reply(ephemeral('Ya estás atendiendo este ticket.'));
            await i.deferUpdate();
            await this.claim(ticketId, by);
        }
    }
}
