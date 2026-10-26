import {
    AttachmentBuilder,
    EmbedBuilder,
    type Client,
    type GuildMember,
    type MessageCreateOptions,
    type User,
} from 'discord.js';
import crypto from 'node:crypto';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { BotError, HttpError, parseJson } from '../../core/http';
import { getFiles, toFileInfo, type FileInfo } from '../../core/files';
import { Logger } from '../../utils/Logger';

const logger = new Logger('MessagesService');

export interface EmbedPayload {
    title?: string;
    description?: string;
    color?: string;
    footer?: string;
    author?: string;
    thumbnail?: string;
    timestamp?: boolean;
}

export interface OutgoingPayload {
    content?: string;
    embed?: EmbedPayload | null;
    fileIds?: string[];
}

export type MessageSource = 'manual' | 'reply' | 'schedule' | 'campaign' | 'welcome' | 'system' | 'dm';

export interface SendMeta {
    source: MessageSource;
    sourceRef?: string;
}

/** Opciones extra que no se guardan en el historial (botones, etc.). */
export interface SendExtras {
    components?: MessageCreateOptions['components'];
}

export type Target =
    | { type: 'user'; id: string }
    | { type: 'users'; ids: string[] }
    | { type: 'role'; id: string }
    | { type: 'all' }
    | { type: 'channel'; id: string };

export interface MessageRecord {
    id: number;
    direction: 'in' | 'out';
    kind: 'dm' | 'channel';
    userId: string | null;
    userTag: string | null;
    userAvatar: string | null;
    channelId: string | null;
    channelName: string | null;
    discordId: string | null;
    content: string;
    embed: EmbedPayload | null;
    source: string;
    sourceRef: string | null;
    status: 'sent' | 'failed' | 'received';
    error: string | null;
    readAt: number | null;
    createdAt: number;
    files: FileInfo[];
}

interface MessageRow {
    id: number;
    direction: 'in' | 'out';
    kind: 'dm' | 'channel';
    user_id: string | null;
    user_tag: string | null;
    user_avatar: string | null;
    channel_id: string | null;
    channel_name: string | null;
    discord_id: string | null;
    content: string;
    embed_json: string | null;
    source: string;
    source_ref: string | null;
    status: 'sent' | 'failed' | 'received';
    error: string | null;
    read_at: number | null;
    created_at: number;
}

export interface HistoryQuery {
    direction?: 'in' | 'out';
    kind?: 'dm' | 'channel';
    source?: string;
    status?: string;
    q?: string;
    userId?: string;
    limit?: number;
    before?: number;
}

export interface BulkResult {
    total: number;
    sent: number;
    failed: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function friendlyDiscordError(err: unknown): string {
    const e = err as { code?: number | string; message?: string };
    if (e?.code === 50007) return 'El usuario tiene los mensajes directos cerrados (o ha bloqueado al bot).';
    if (e?.code === 10013) return 'Usuario desconocido.';
    if (e?.code === 10003) return 'Canal desconocido.';
    if (e?.code === 50001 || e?.code === 50013) return 'El bot no tiene permisos para hacer eso.';
    return e?.message ?? String(err);
}

export class MessagesService {
    /** Si es false (módulo desactivado) NO se envía nada: funciona como botón de pausa global. */
    active = false;
    private readonly batches = new Map<string, { total: number; done: number; failed: number; finished: boolean }>();

    constructor(private readonly client: Client, private readonly db: DB) {}

    private assertActive(): void {
        if (!this.active) throw new BotError('El módulo de mensajes está desactivado (envíos en pausa).');
    }

    private guild() {
        return this.client.guilds.cache.get(env.guildId);
    }

    // ───────────────────────────── Envío ─────────────────────────────

    async sendToUser(userId: string, payload: OutgoingPayload, meta: SendMeta, extras: SendExtras = {}): Promise<MessageRecord> {
        this.assertActive();
        this.validatePayload(payload, extras);
        let user: User | null = null;
        try {
            user = await this.client.users.fetch(userId);
            const options = this.buildOptions(payload, { user, member: this.guild()?.members.cache.get(userId) }, extras);
            const sent = await user.send(options);
            return this.record({
                direction: 'out', kind: 'dm', userId, userTag: user.username, userAvatar: user.displayAvatarURL({ size: 64 }),
                discordId: sent.id, payload, meta, status: 'sent',
            });
        } catch (err) {
            logger.warn(`No se pudo enviar el DM a ${user?.username ?? userId}: ${friendlyDiscordError(err)}`);
            return this.record({
                direction: 'out', kind: 'dm', userId, userTag: user?.username ?? null,
                userAvatar: user?.displayAvatarURL({ size: 64 }) ?? null,
                payload, meta, status: 'failed', error: friendlyDiscordError(err),
            });
        }
    }

    async sendToChannel(channelId: string, payload: OutgoingPayload, meta: SendMeta, extras: SendExtras = {}): Promise<MessageRecord> {
        this.assertActive();
        this.validatePayload(payload, extras);
        let channelName: string | null = null;
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !('send' in channel)) throw new BotError('Ese canal no admite mensajes.');
            channelName = 'name' in channel ? (channel.name as string) : null;
            const options = this.buildOptions(payload, {}, extras);
            const sent = await (channel as { send: (o: MessageCreateOptions) => Promise<{ id: string }> }).send(options);
            return this.record({
                direction: 'out', kind: 'channel', channelId, channelName, discordId: sent.id, payload, meta, status: 'sent',
            });
        } catch (err) {
            logger.warn(`No se pudo enviar al canal ${channelId}: ${friendlyDiscordError(err)}`);
            return this.record({
                direction: 'out', kind: 'channel', channelId, channelName, payload, meta, status: 'failed', error: friendlyDiscordError(err),
            });
        }
    }

    /** Envío secuencial con pausa entre mensajes para no chocar con los rate limits de Discord. */
    async sendBulk(
        userIds: string[],
        payload: OutgoingPayload,
        meta: SendMeta,
        opts: { delayMs?: number; batchId?: string } = {}
    ): Promise<BulkResult> {
        this.assertActive();
        this.validatePayload(payload, {});
        const batchId = opts.batchId ?? crypto.randomUUID();
        const delay = opts.delayMs ?? 1100;
        const state = { total: userIds.length, done: 0, failed: 0, finished: false };
        this.batches.set(batchId, state);
        publish('bulk:progress', { batchId, ...state });

        for (const id of userIds) {
            if (!this.active) {
                logger.warn('Envío masivo interrumpido: el módulo de mensajes se desactivó.');
                break;
            }
            const rec = await this.sendToUser(id, payload, meta).catch(err => {
                logger.error('Error inesperado en envío masivo', err);
                return null;
            });
            state.done++;
            if (!rec || rec.status === 'failed') state.failed++;
            publish('bulk:progress', { batchId, ...state });
            if (state.done < userIds.length) await sleep(delay);
        }
        state.finished = true;
        publish('bulk:progress', { batchId, ...state });
        setTimeout(() => this.batches.delete(batchId), 10 * 60 * 1000).unref();
        return { total: state.total, sent: state.done - state.failed, failed: state.failed };
    }

    batch(id: string) {
        return this.batches.get(id) ?? null;
    }

    // ─────────────────────────── Destinatarios ───────────────────────────

    resolveUserIds(target: Exclude<Target, { type: 'channel' }>): string[] {
        const guild = this.guild();
        switch (target.type) {
            case 'user':
                return [target.id];
            case 'users':
                return [...new Set(target.ids)];
            case 'role': {
                const role = guild?.roles.cache.get(target.id);
                if (!role) throw new HttpError(404, 'Rol no encontrado');
                return role.members.filter((m: GuildMember) => !m.user.bot).map((m: GuildMember) => m.id);
            }
            case 'all': {
                if (!guild) throw new HttpError(503, 'El servidor aún no está cargado');
                return guild.members.cache.filter(m => !m.user.bot).map(m => m.id);
            }
        }
    }

    // ───────────────────────────── Historial ─────────────────────────────

    list(q: HistoryQuery): MessageRecord[] {
        const where: string[] = [];
        const params: Record<string, unknown> = {};
        if (q.direction) { where.push('direction = @direction'); params.direction = q.direction; }
        if (q.kind) { where.push('kind = @kind'); params.kind = q.kind; }
        if (q.source) { where.push('source = @source'); params.source = q.source; }
        if (q.status) { where.push('status = @status'); params.status = q.status; }
        if (q.userId) { where.push('user_id = @userId'); params.userId = q.userId; }
        if (q.before) { where.push('id < @before'); params.before = q.before; }
        if (q.q) {
            where.push("(content LIKE @q ESCAPE '\\' OR user_tag LIKE @q ESCAPE '\\' OR channel_name LIKE @q ESCAPE '\\')");
            params.q = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
        }
        params.limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
        const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @limit`;
        const rows = this.db.prepare(sql).all(params) as MessageRow[];
        return rows.map(r => this.toRecord(r));
    }

    get(id: number): MessageRecord | null {
        const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
        return row ? this.toRecord(row) : null;
    }

    deleteFromLog(id: number): boolean {
        const res = this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
        if (res.changes) publish('message:deleted', { id });
        return res.changes > 0;
    }

    // ───────────────────────── Registro en BD ─────────────────────────

    /** Inserta un mensaje (enviado o recibido) en el historial y avisa al panel. */
    record(input: {
        direction: 'in' | 'out';
        kind: 'dm' | 'channel';
        userId?: string | null;
        userTag?: string | null;
        userAvatar?: string | null;
        channelId?: string | null;
        channelName?: string | null;
        discordId?: string | null;
        payload: OutgoingPayload;
        meta: SendMeta;
        status: 'sent' | 'failed' | 'received';
        error?: string;
        fileIds?: string[];
    }): MessageRecord {
        const fileIds = input.fileIds ?? input.payload.fileIds ?? [];
        const insert = this.db.transaction(() => {
            const res = this.db.prepare(`
                INSERT INTO messages (direction, kind, user_id, user_tag, user_avatar, channel_id, channel_name, discord_id,
                                      content, embed_json, source, source_ref, status, error, created_at)
                VALUES (@direction, @kind, @userId, @userTag, @userAvatar, @channelId, @channelName, @discordId,
                        @content, @embed, @source, @sourceRef, @status, @error, @createdAt)
            `).run({
                direction: input.direction,
                kind: input.kind,
                userId: input.userId ?? null,
                userTag: input.userTag ?? null,
                userAvatar: input.userAvatar ?? null,
                channelId: input.channelId ?? null,
                channelName: input.channelName ?? null,
                discordId: input.discordId ?? null,
                content: input.payload.content ?? '',
                embed: input.payload.embed ? JSON.stringify(input.payload.embed) : null,
                source: input.meta.source,
                sourceRef: input.meta.sourceRef ?? null,
                status: input.status,
                error: input.error ?? null,
                createdAt: Date.now(),
            });
            const id = Number(res.lastInsertRowid);
            const link = this.db.prepare('INSERT OR IGNORE INTO message_files (message_id, file_id) VALUES (?, ?)');
            for (const fid of fileIds) link.run(id, fid);
            return id;
        });
        const record = this.get(insert())!;
        publish('message:new', record);
        return record;
    }

    private toRecord(r: MessageRow): MessageRecord {
        const files = this.db.prepare(
            'SELECT f.* FROM files f JOIN message_files mf ON mf.file_id = f.id WHERE mf.message_id = ?'
        ).all(r.id) as Parameters<typeof toFileInfo>[0][];
        return {
            id: r.id,
            direction: r.direction,
            kind: r.kind,
            userId: r.user_id,
            userTag: r.user_tag,
            userAvatar: r.user_avatar,
            channelId: r.channel_id,
            channelName: r.channel_name,
            discordId: r.discord_id,
            content: r.content,
            embed: parseJson<EmbedPayload | null>(r.embed_json, null),
            source: r.source,
            sourceRef: r.source_ref,
            status: r.status,
            error: r.error,
            readAt: r.read_at,
            createdAt: r.created_at,
            files: files.map(toFileInfo),
        };
    }

    // ───────────────────────── Construcción del mensaje ─────────────────────────

    private validatePayload(payload: OutgoingPayload, extras: SendExtras): void {
        const hasContent = !!payload.content?.trim();
        const hasEmbed = !!(payload.embed && (payload.embed.title || payload.embed.description));
        const hasFiles = !!payload.fileIds?.length;
        if (!hasContent && !hasEmbed && !hasFiles && !extras.components) {
            throw new HttpError(400, 'El mensaje está vacío: añade texto, un embed o una imagen.');
        }
        if ((payload.content?.length ?? 0) > 2000) throw new HttpError(400, 'El texto supera los 2000 caracteres de Discord.');
        if ((payload.fileIds?.length ?? 0) > 10) throw new HttpError(400, 'Discord admite como máximo 10 archivos por mensaje.');
    }

    /** Sustituye variables como {user} o {server} por los datos de cada destinatario. */
    render(text: string, ctx: { user?: User; member?: GuildMember }): string {
        const display = ctx.member?.displayName ?? ctx.user?.globalName ?? ctx.user?.username ?? '';
        return text
            .replaceAll('{user}', display)
            .replaceAll('{username}', ctx.user?.username ?? '')
            .replaceAll('{mention}', ctx.user ? `<@${ctx.user.id}>` : '')
            .replaceAll('{server}', this.guild()?.name ?? '');
    }

    private buildOptions(payload: OutgoingPayload, ctx: { user?: User; member?: GuildMember }, extras: SendExtras): MessageCreateOptions {
        const options: MessageCreateOptions = {};
        if (payload.content?.trim()) options.content = this.render(payload.content, ctx);

        const e = payload.embed;
        if (e && (e.title || e.description)) {
            const embed = new EmbedBuilder();
            if (e.title) embed.setTitle(this.render(e.title, ctx).slice(0, 256));
            if (e.description) embed.setDescription(this.render(e.description, ctx).slice(0, 4096));
            if (e.color && /^#?[0-9a-f]{6}$/i.test(e.color)) embed.setColor(parseInt(e.color.replace('#', ''), 16));
            if (e.footer) embed.setFooter({ text: this.render(e.footer, ctx).slice(0, 2048) });
            if (e.author) embed.setAuthor({ name: this.render(e.author, ctx).slice(0, 256) });
            if (e.thumbnail) embed.setThumbnail(e.thumbnail === '{avatar}' && ctx.user ? ctx.user.displayAvatarURL({ size: 1024 }) : e.thumbnail);
            if (e.timestamp) embed.setTimestamp();
            options.embeds = [embed];
        }

        if (payload.fileIds?.length) {
            const files = getFiles(this.db, payload.fileIds);
            if (files.length !== payload.fileIds.length) throw new HttpError(400, 'Alguno de los archivos adjuntos ya no existe.');
            options.files = files.map(f => new AttachmentBuilder((f.path ?? f.url)!, { name: f.name }));
        }
        if (extras.components) options.components = extras.components;
        return options;
    }
}
