import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MessageReferenceType, MessageType, StickerFormatType, type Client, type Message } from 'discord.js';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import type { DB } from '../../core/db';
import { NEWS_DIR, getSetting, setSetting } from '../../core/db';
import { isInlineImage } from '../../core/files';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { toMarkdown, toPlainText, type MentionResolver } from './text';

const logger = new Logger('News');
const KEY = 'news.config';
const FEED_VERSION = 1;
const FEED_SIZE = 10;
/** Se piden más de los que se publican porque parte se filtra (sistema, solo vídeo…). */
const FETCH_SIZE = 50;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGES_DIR = path.join(NEWS_DIR, 'images');
const FEED_FILE = path.join(NEWS_DIR, 'latest.json');
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const DISCORD_MEDIA_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export interface NewsConfig {
    channelId: string | null;
}

export interface NewsPoll {
    question: string;
    answers: Array<{ text: string; emoji?: string; votes: number }>;
    expiresAt: string | null;
    finalized: boolean;
}

export interface NewsMessage {
    id: string;
    author: { name: string; avatarUrl?: string };
    content: string;
    markdown?: string;
    createdAt: string;
    url: string;
    images: Array<{ url: string }>;
    poll: NewsPoll | null;
}

export interface NewsFeed {
    version: number;
    updatedAt: string;
    messages: NewsMessage[];
}

export interface NewsState {
    config: NewsConfig;
    feed: NewsFeed | null;
    lastError: string | null;
}

interface ImageSource {
    id: string;
    url: string;
}

function atomicWrite(file: string, data: string | Buffer): void {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

const baseMime = (mime: string | null | undefined): string => (mime ?? '').split(';')[0].trim().toLowerCase();

export class NewsService {
    private chain: Promise<unknown> = Promise.resolve();
    private lastError: string | null = null;
    private debounce: NodeJS.Timeout | null = null;

    constructor(private readonly client: Client, private readonly db: DB) {}

    getConfig(): NewsConfig {
        return { channelId: null, ...parseJson<Partial<NewsConfig>>(getSetting(this.db, KEY, ''), {}) };
    }

    setConfig(cfg: NewsConfig): void {
        setSetting(this.db, KEY, JSON.stringify(cfg));
    }

    getState(): NewsState {
        let feed: NewsFeed | null = null;
        try {
            feed = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')) as NewsFeed;
        } catch {
            // Aún no se ha publicado nada.
        }
        return { config: this.getConfig(), feed, lastError: this.lastError };
    }

    isNewsChannel(channelId: string): boolean {
        return channelId === this.getConfig().channelId;
    }

    /** Agrupa ráfagas de cambios (un mensaje nuevo también genera ediciones al resolver sus embeds). */
    schedule(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
            this.debounce = null;
            void this.publishNow();
        }, 3000);
    }

    cancelScheduled(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = null;
    }

    /** Regenera el fichero desde Discord. Las ejecuciones van en fila para no pisarse. Si falla, se conserva el último. */
    publishNow(): Promise<NewsState> {
        const run = this.chain.then(async () => {
            try {
                await this.generate();
                this.lastError = null;
            } catch (err) {
                this.lastError = err instanceof Error ? err.message : String(err);
                logger.error('No se pudieron publicar las noticias', err);
            }
            const state = this.getState();
            publish('news:published', state);
            return state;
        });
        this.chain = run;
        return run;
    }

    private async generate(): Promise<void> {
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
        const { channelId } = this.getConfig();
        const referenced = new Set<string>();
        const messages: NewsMessage[] = [];

        if (channelId) {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isTextBased()) throw new HttpError(400, 'El canal de noticias no existe o no es de texto.');
            const fetched = await channel.messages.fetch({ limit: FETCH_SIZE });
            const newestFirst = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
            const stored = this.storedImages();
            for (const msg of newestFirst) {
                if (messages.length === FEED_SIZE) break;
                const item = await this.toNewsMessage(msg, stored, referenced);
                if (item) messages.push(item);
            }
        }

        const feed: NewsFeed = { version: FEED_VERSION, updatedAt: new Date().toISOString(), messages };
        atomicWrite(FEED_FILE, JSON.stringify(feed, null, 2));

        // Sin copias de lo borrado: solo quedan las imágenes que usa el fichero recién escrito.
        for (const name of fs.readdirSync(IMAGES_DIR)) {
            if (!referenced.has(name)) fs.rmSync(path.join(IMAGES_DIR, name), { force: true });
        }
    }

    private async toNewsMessage(msg: Message, stored: Map<string, string>, referenced: Set<string>): Promise<NewsMessage | null> {
        if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return null;

        const snapshot = msg.reference?.type === MessageReferenceType.Forward ? msg.messageSnapshots.first() : undefined;
        const source = snapshot ?? msg;

        const names = this.mentionResolver();
        const plain = (text: string | null | undefined) => (text ? toPlainText(text, names, env.timezone) : '');
        const richEmbeds = source.embeds.filter(e => e.data.type === 'rich');
        const formatted = (text: string | null | undefined) => (text ? toMarkdown(text, names, env.timezone) : '');
        const content = [
            plain(source.content),
            ...richEmbeds.flatMap(e => [plain(e.title), plain(e.description)]),
        ].filter(Boolean).join('\n\n');
        const markdown = [
            formatted(source.content),
            ...richEmbeds.flatMap(e => [e.title && `**${formatted(e.title)}**`, formatted(e.description)]),
        ].filter(Boolean).join('\n\n');

        const sources: ImageSource[] = [];
        for (const att of source.attachments.values()) {
            if (isInlineImage(baseMime(att.contentType))) sources.push({ id: att.id, url: att.url });
        }
        for (const embed of richEmbeds) {
            const url = embed.image?.proxyURL ?? embed.image?.url;
            if (url && DISCORD_MEDIA_HOSTS.has(new URL(url).hostname)) {
                sources.push({ id: crypto.createHash('sha256').update(url.split('?')[0]).digest('hex').slice(0, 32), url });
            }
        }
        for (const sticker of source.stickers.values()) {
            if (sticker.format !== StickerFormatType.Lottie) sources.push({ id: sticker.id, url: sticker.url });
        }

        const poll = this.toPoll(msg);
        if (!content && !sources.length && !poll) return null;

        const images: Array<{ url: string }> = [];
        for (const image of sources) {
            const url = await this.publishImage(image, stored, referenced);
            if (url) images.push({ url });
        }
        if (!content && !images.length && !poll) return null;

        const avatarUrl = msg.author.displayAvatarURL({ extension: 'png', size: 64 });
        return {
            id: msg.id,
            author: {
                name: msg.member?.displayName ?? msg.author.displayName,
                ...(avatarUrl.startsWith('https://') ? { avatarUrl } : {}),
            },
            content,
            ...(content ? { markdown } : {}),
            createdAt: msg.createdAt.toISOString(),
            url: msg.url,
            images,
            poll,
        };
    }

    private toPoll(msg: Message): NewsPoll | null {
        const poll = msg.poll;
        if (!poll?.question.text) return null;
        const answers: NewsPoll['answers'] = [];
        for (const answer of poll.answers.values()) {
            if (!answer.text) continue;
            const emoji = answer.emoji;
            answers.push({
                text: answer.text,
                ...(emoji?.name && !emoji.id ? { emoji: emoji.name } : {}),
                votes: answer.voteCount ?? 0,
            });
        }
        if (!answers.length) return null;
        return {
            question: poll.question.text,
            answers,
            expiresAt: poll.expiresAt?.toISOString() ?? null,
            finalized: poll.resultsFinalized ?? false,
        };
    }

    /** id de la imagen → nombre del fichero ya descargado. */
    private storedImages(): Map<string, string> {
        return new Map(fs.readdirSync(IMAGES_DIR).map(name => [path.parse(name).name, name]));
    }

    /** Copia servida desde nuestro dominio; si no se puede descargar, el enlace de Discord recién firmado. */
    private async publishImage(image: ImageSource, stored: Map<string, string>, referenced: Set<string>): Promise<string | null> {
        const fallback = image.url.startsWith('https://') ? image.url : null;
        if (!env.news.publicUrl.startsWith('https://')) return fallback;

        let name = stored.get(image.id);
        if (!name) {
            try {
                const res = await fetch(image.url, { signal: AbortSignal.timeout(15_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const mime = baseMime(res.headers.get('content-type'));
                if (!isInlineImage(mime)) return null;
                const data = Buffer.from(await res.arrayBuffer());
                if (data.length > MAX_IMAGE_BYTES) return fallback;
                name = `${image.id}.${EXTENSIONS[mime]}`;
                atomicWrite(path.join(IMAGES_DIR, name), data);
                stored.set(image.id, name);
            } catch (err) {
                logger.warn(`No se pudo descargar la imagen ${image.id}: ${String(err)}`);
                return fallback;
            }
        }
        referenced.add(name);
        return `${env.news.publicUrl}/images/${name}`;
    }

    private mentionResolver(): MentionResolver {
        const guild = this.client.guilds.cache.get(env.guildId);
        return {
            user: id => guild?.members.cache.get(id)?.displayName ?? this.client.users?.cache?.get(id)?.displayName,
            role: id => guild?.roles.cache.get(id)?.name,
            channel: id => guild?.channels.cache.get(id)?.name,
        };
    }
}
