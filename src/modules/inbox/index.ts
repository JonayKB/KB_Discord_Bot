import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type Message,
} from 'discord.js';
import { Router } from 'express';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError, asyncRoute, bool, int, str, strArray } from '../../core/http';
import { downloadAttachment } from '../../core/files';
import type { BotModule } from '../../core/module';
import { friendlyDiscordError, type MessageRecord, type MessagesService } from '../messages/service';

const FORWARD_KEY = 'inbox.forward_to_admin';
const REPLY_PREFIX = 'reply_';

export interface Conversation {
    userId: string;
    userTag: string | null;
    userAvatar: string | null;
    lastAt: number;
    unread: number;
    preview: string;
}

export class InboxService {
    constructor(private readonly db: DB, private readonly messages: MessagesService) {}

    conversations(): Conversation[] {
        const rows = this.db.prepare(`
            SELECT m.user_id AS userId,
                   (SELECT user_tag    FROM messages WHERE user_id = m.user_id AND user_tag    IS NOT NULL ORDER BY id DESC LIMIT 1) AS userTag,
                   (SELECT user_avatar FROM messages WHERE user_id = m.user_id AND user_avatar IS NOT NULL ORDER BY id DESC LIMIT 1) AS userAvatar,
                   MAX(m.created_at) AS lastAt,
                   SUM(CASE WHEN m.direction = 'in' AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
                   (SELECT content    FROM messages x WHERE x.user_id = m.user_id AND x.kind = 'dm' ORDER BY x.id DESC LIMIT 1) AS lastContent,
                   (SELECT embed_json FROM messages x WHERE x.user_id = m.user_id AND x.kind = 'dm' ORDER BY x.id DESC LIMIT 1) AS lastEmbed,
                   (SELECT COUNT(*)   FROM message_files mf JOIN messages x ON x.id = mf.message_id
                     WHERE x.user_id = m.user_id AND x.kind = 'dm' AND x.id = (SELECT MAX(id) FROM messages WHERE user_id = m.user_id AND kind = 'dm')) AS lastFiles
            FROM messages m
            WHERE m.kind = 'dm' AND m.user_id IS NOT NULL
              AND m.user_id IN (SELECT DISTINCT user_id FROM messages
                                 WHERE kind = 'dm' AND (direction = 'in' OR source = 'reply' OR (source = 'manual' AND source_ref IS NULL)))
            GROUP BY m.user_id
            ORDER BY lastAt DESC
            LIMIT 300
        `).all() as Array<Omit<Conversation, 'preview'> & { lastContent: string | null; lastEmbed: string | null; lastFiles: number }>;

        return rows.map(r => {
            let preview = r.lastContent?.trim() ?? '';
            if (!preview && r.lastEmbed) {
                try {
                    const e = JSON.parse(r.lastEmbed) as { title?: string; description?: string };
                    preview = `📋 ${e.title ?? e.description ?? 'Embed'}`;
                } catch { preview = '📋 Embed'; }
            }
            if (!preview && r.lastFiles > 0) preview = '📎 Adjunto';
            return {
                userId: r.userId,
                userTag: r.userTag,
                userAvatar: r.userAvatar,
                lastAt: r.lastAt,
                unread: r.unread,
                preview: preview.slice(0, 120),
            };
        });
    }

    thread(userId: string, limit = 100, before?: number): MessageRecord[] {
        const msgs = this.messages.list({ kind: 'dm', userId, limit, before });
        return msgs.reverse();
    }

    markRead(userId: string): number {
        const res = this.db.prepare(
            "UPDATE messages SET read_at = ? WHERE user_id = ? AND direction = 'in' AND read_at IS NULL"
        ).run(Date.now(), userId);
        if (res.changes) publish('inbox:read', { userId });
        return res.changes;
    }

    unreadTotal(): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND kind = 'dm' AND read_at IS NULL").get() as { n: number };
        return row.n;
    }

    forwardEnabled(): boolean {
        return getSetting(this.db, FORWARD_KEY, '1') === '1';
    }

    setForward(on: boolean): void {
        setSetting(this.db, FORWARD_KEY, on ? '1' : '0');
    }
}

export function createInboxModule(inbox: InboxService, messages: MessagesService, db: DB): BotModule {
    const router = Router();

    router.get('/conversations', (_req, res) => {
        res.json({ conversations: inbox.conversations(), unreadTotal: inbox.unreadTotal() });
    });

    router.get('/conversations/:userId', asyncRoute((req, res) => {
        const limit = req.query.limit ? int(req.query.limit, 'limit', { min: 1, max: 200 }) : 100;
        const before = req.query.before ? int(req.query.before, 'before', { min: 1 }) : undefined;
        res.json(inbox.thread(String(req.params.userId), limit, before));
    }));

    router.post('/conversations/:userId/read', (req, res) => {
        res.json({ marked: inbox.markRead(String(req.params.userId)) });
    });

    router.post('/conversations/:userId/reply', asyncRoute(async (req, res) => {
        const content = str(req.body?.content, 'content', { max: 2000 });
        const fileIds = strArray(req.body?.fileIds, 'fileIds', 10);
        if (!content.trim() && !fileIds.length) throw new HttpError(400, 'Escribe algo o adjunta una imagen.');
        const rec = await messages.sendToUser(String(req.params.userId), { content, fileIds }, { source: 'reply' });
        if (rec.status === 'failed') throw new HttpError(502, rec.error ?? 'No se pudo enviar');
        inbox.markRead(String(req.params.userId));
        res.json(rec);
    }));

    router.get('/settings', (_req, res) => {
        res.json({ forwardToAdmin: inbox.forwardEnabled() });
    });

    router.put('/settings', (req, res) => {
        if (req.body && 'forwardToAdmin' in req.body) inbox.setForward(bool(req.body.forwardToAdmin));
        res.json({ forwardToAdmin: inbox.forwardEnabled() });
    });

    return {
        id: 'inbox',
        name: 'Bandeja de entrada',
        description: 'Guarda los mensajes privados que recibe el bot (con imágenes), permite verlos y responderlos desde el panel y, opcionalmente, los reenvía al admin por Discord.',
        router,

        start(ctx) {
            const { client, logger } = ctx;

            ctx.listen('messageCreate', async (message: Message) => {
                if (message.author.bot) return;
                if (message.channel.type !== ChannelType.DM) return;

                logger.info(`📩 DM de ${message.author.username}: ${message.content || '[sin texto]'}`);

                const maxBytes = env.maxUploadMb * 1024 * 1024;
                const fileIds: string[] = [];
                for (const att of message.attachments.values()) {
                    const f = await downloadAttachment(db, { url: att.url, name: att.name, contentType: att.contentType, size: att.size }, maxBytes);
                    fileIds.push(f.id);
                }

                messages.record({
                    direction: 'in',
                    kind: 'dm',
                    userId: message.author.id,
                    userTag: message.author.username,
                    userAvatar: message.author.displayAvatarURL({ size: 64 }),
                    discordId: message.id,
                    payload: { content: message.content },
                    meta: { source: 'dm' },
                    status: 'received',
                    fileIds,
                });

                if (!inbox.forwardEnabled()) return;
                try {
                    const admin = await client.users.fetch(env.adminId);
                    const embed = {
                        title: `📩 Nuevo MD de ${message.author.username}`,
                        description: message.content || '[sin texto]',
                        color: 0x00ae86,
                        fields: [{ name: 'Usuario', value: `${message.author.username} (${message.author.id})`, inline: true }],
                        timestamp: new Date().toISOString(),
                    };
                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId(`${REPLY_PREFIX}${message.author.id}`).setLabel('Responder').setStyle(ButtonStyle.Primary)
                    );
                    await admin.send({
                        embeds: [embed],
                        components: [row],
                        files: [...message.attachments.values()].slice(0, 10).map(a => a.url),
                    });
                } catch (err) {
                    logger.error('No se pudo reenviar el MD al admin', err);
                }
            });

            // Botón "Responder" del reenvío al admin (se mantiene la función de siempre).
            ctx.listen('interactionCreate', async interaction => {
                if (interaction.isButton() && interaction.customId.startsWith(REPLY_PREFIX)) {
                    const userId = interaction.customId.slice(REPLY_PREFIX.length);
                    const modal = new ModalBuilder()
                        .setCustomId(`reply_modal_${userId}`)
                        .setTitle('Responder al usuario')
                        .addComponents(
                            new ActionRowBuilder<TextInputBuilder>().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('response_input')
                                    .setLabel('Tu respuesta')
                                    .setStyle(TextInputStyle.Paragraph)
                                    .setRequired(true)
                            )
                        );
                    await interaction.showModal(modal);
                } else if (interaction.isModalSubmit() && interaction.customId.startsWith('reply_modal_')) {
                    const userId = interaction.customId.slice('reply_modal_'.length);
                    const text = interaction.fields.getTextInputValue('response_input');
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    try {
                        const rec = await messages.sendToUser(userId, { content: `📩 Respuesta del Administrador: ${text}` }, { source: 'reply' });
                        await interaction.editReply(rec.status === 'sent' ? '✅ Mensaje enviado al usuario' : `❌ No se pudo enviar: ${rec.error}`);
                    } catch (err) {
                        await interaction.editReply(`❌ No se pudo enviar: ${friendlyDiscordError(err)}`);
                    }
                }
            });
        },
    };
}
