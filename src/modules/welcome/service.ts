import type { Client, GuildMember, PartialGuildMember } from 'discord.js';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { MessageRecord, MessagesService, OutgoingPayload } from '../messages/service';

const logger = new Logger('Welcome');
const KEY = 'welcome.config';

export interface WelcomeMessage {
    enabled: boolean;
    payload: OutgoingPayload;
}

export interface WelcomeChannelMessage extends WelcomeMessage {
    channelId: string | null;
}

export interface WelcomeConfig {
    /** Mensaje directo al que entra. */
    dm: WelcomeMessage;
    /** Mensaje público en un canal cuando alguien entra. */
    channel: WelcomeChannelMessage;
    /** Mensaje en un canal cuando alguien se va. */
    goodbye: WelcomeChannelMessage;
    /** Roles que se dan automáticamente al entrar. */
    autoRoleIds: string[];
    /** No dar la bienvenida ni roles a otros bots. */
    ignoreBots: boolean;
}

export type WelcomeKind = 'dm' | 'channel' | 'goodbye';

/** Lo que había antes escrito en el código (events/guild/memberAdd.ts): se mantiene como valor por defecto. */
export const DEFAULT_CONFIG: WelcomeConfig = {
    dm: {
        enabled: true,
        payload: {
            content: '',
            embed: {
                author: '🐉 MCKBSERVERS',
                title: '✨ ¡Bienvenido!',
                description:
                    'Hey **{username}**, nos alegra verte por aquí 💚  \n\n' +
                    '> Este es mi servidor de Discord, donde encontrarás **los mejores servidores de juegos** que soy capaz de crear.  \n' +
                    '> ¡Espero que disfrutes tu estancia y te unas a la aventura! 🚀',
                color: '#00FF00',
                thumbnail: '{avatar}',
                footer: 'Sistema automático de bienvenida',
                timestamp: true,
            },
            fileIds: [],
        },
    },
    channel: {
        enabled: false,
        channelId: null,
        payload: { content: '👋 ¡Bienvenido {mention} a **{server}**! Ya somos {count}.', embed: null, fileIds: [] },
    },
    goodbye: {
        enabled: false,
        channelId: null,
        payload: { content: '👋 **{username}** ha salido del servidor. Ahora somos {count}.', embed: null, fileIds: [] },
    },
    autoRoleIds: [],
    ignoreBots: true,
};

export class WelcomeService {
    active = false;

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly messages: MessagesService
    ) {}

    getConfig(): WelcomeConfig {
        const saved = parseJson<Partial<WelcomeConfig>>(getSetting(this.db, KEY, ''), {});
        return {
            dm: { ...DEFAULT_CONFIG.dm, ...saved.dm },
            channel: { ...DEFAULT_CONFIG.channel, ...saved.channel },
            goodbye: { ...DEFAULT_CONFIG.goodbye, ...saved.goodbye },
            autoRoleIds: saved.autoRoleIds ?? DEFAULT_CONFIG.autoRoleIds,
            ignoreBots: saved.ignoreBots ?? DEFAULT_CONFIG.ignoreBots,
        };
    }

    setConfig(cfg: WelcomeConfig): WelcomeConfig {
        if (cfg.channel.enabled && !cfg.channel.channelId) throw new HttpError(400, 'Elige el canal del mensaje de bienvenida.');
        if (cfg.goodbye.enabled && !cfg.goodbye.channelId) throw new HttpError(400, 'Elige el canal del mensaje de despedida.');
        const guild = this.client.guilds.cache.get(env.guildId);
        if (guild) {
            const missing = cfg.autoRoleIds.filter(id => !guild.roles.cache.has(id));
            if (missing.length) throw new HttpError(400, 'Alguno de los roles automáticos ya no existe.');
        }
        setSetting(this.db, KEY, JSON.stringify(cfg));
        publish('welcome:changed', {});
        return this.getConfig();
    }

    async onJoin(member: GuildMember): Promise<void> {
        if (!this.active) return;
        const cfg = this.getConfig();
        if (cfg.ignoreBots && member.user.bot) return;
        logger.info(`➡️ Nuevo miembro: ${member.user.username}`);

        if (cfg.autoRoleIds.length) {
            await member.roles.add(cfg.autoRoleIds, 'Rol automático al entrar')
                .then(() => logger.info(`➕ Roles automáticos dados a ${member.user.username}`))
                .catch(err => logger.warn(`No se pudieron dar los roles automáticos a ${member.user.username}: ${(err as Error).message}`));
        }
        if (cfg.dm.enabled) await this.send('dm', cfg, member).catch(err => logger.warn(`Bienvenida por MD: ${(err as Error).message}`));
        if (cfg.channel.enabled) await this.send('channel', cfg, member).catch(err => logger.warn(`Bienvenida en canal: ${(err as Error).message}`));
    }

    async onLeave(member: GuildMember | PartialGuildMember): Promise<void> {
        if (!this.active) return;
        const cfg = this.getConfig();
        if (cfg.ignoreBots && member.user?.bot) return;
        logger.info(`⬅️ Miembro salió: ${member.user?.username ?? member.id}`);
        if (cfg.goodbye.enabled) await this.send('goodbye', cfg, member as GuildMember).catch(err => logger.warn(`Despedida: ${(err as Error).message}`));
    }

    private send(kind: WelcomeKind, cfg: WelcomeConfig, member: GuildMember): Promise<MessageRecord> {
        if (kind === 'dm') return this.messages.sendToUser(member.id, cfg.dm.payload, { source: 'welcome' });
        const msg = cfg[kind];
        if (!msg.channelId) throw new HttpError(400, 'Falta el canal.');
        return this.messages.sendToChannel(msg.channelId, msg.payload, { source: 'welcome', sourceRef: kind }, { about: { user: member.user, member } });
    }

    /**
     * Envía una prueba del mensaje (con la configuración que se está editando) como si quien
     * usa el panel acabara de entrar. El MD le llega a él; los de canal, al canal elegido.
     */
    async test(kind: WelcomeKind, cfg: WelcomeConfig, userId: string): Promise<MessageRecord> {
        const guild = this.client.guilds.cache.get(env.guildId);
        const member = await guild?.members.fetch(userId).catch(() => null);
        if (!member) throw new HttpError(400, 'Para probarlo tienes que estar en el servidor de Discord.');
        const res = await this.send(kind, cfg, member);
        if (res.status === 'failed') throw new HttpError(400, `No se pudo enviar: ${res.error}`);
        return res;
    }
}
