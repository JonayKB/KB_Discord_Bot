/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import { ChannelType, Collection } from 'discord.js';

/**
 * Cliente de Discord simulado (solo para pruebas y para ver el panel sin conectarse a Discord).
 * Imita lo mínimo que usa el bot: usuarios, miembros, roles, canales y envío de MD.
 */
export function createMockDiscord(guildId = 'G1') {
    const sent: Array<{ to: string; opts: any }> = [];
    const roleLog: string[] = [];
    const nickLog: string[] = [];
    const channelsSent: any[] = [];
    const counterEdits: any[] = [];
    const users = new Map<string, any>();

    const mkUser = (id: string, username: string) => {
        const u: any = {
            id, username, globalName: username.toUpperCase(), bot: false,
            displayAvatarURL: () => '',
            send: async (opts: any) => {
                if (id === 'CLOSED') throw Object.assign(new Error('Cannot send'), { code: 50007 });
                sent.push({ to: id, opts });
                return { id: `m${sent.length}` };
            },
        };
        users.set(id, u);
        return u;
    };

    const mkMember = (id: string, username: string, roles: string[] = []) => {
        const user = users.get(id) ?? mkUser(id, username);
        const m: any = {
            id, user, displayName: user.globalName, nickname: null, manageable: true,
            roles: {
                cache: new Collection<string, any>(roles.map(r => [r, { id: r }])),
                add: async (r: any) => { for (const x of [r].flat()) { m.roles.cache.set(x, { id: x }); roleLog.push(`+${id}:${x}`); } },
                remove: async (r: any) => { for (const x of [r].flat()) { m.roles.cache.delete(x); roleLog.push(`-${id}:${x}`); } },
            },
            setNickname: async (n: string | null) => { nickLog.push(`${id}:${n}`); m.nickname = n; },
        };
        return m;
    };

    const members = new Collection<string, any>();
    const addMember = (id: string, username: string, roles: string[] = []) => { const m = mkMember(id, username, roles); members.set(id, m); return m; };

    const roles = new Collection<string, any>([[guildId, { id: guildId }]]);
    const addRole = (id: string, name: string, color = '#99aab5') => {
        const r: any = { id, name, hexColor: color, position: roles.size, managed: false, members: new Collection<string, any>() };
        roles.set(id, r);
        return r;
    };

    const emojis = new Collection<string, any>();
    const addEmoji = (id: string, name: string) => emojis.set(id, { id, name, animated: false, toString: () => `<:${name}:${id}>`, imageURL: () => '' });

    const channels = new Collection<string, any>();
    const addChannel = (id: string, name: string) => channels.set(id, { id, name, type: ChannelType.GuildText, position: channels.size, parent: null });

    const guild: any = {
        id: guildId, name: 'MCKBServers', get memberCount() { return members.size; }, iconURL: () => null,
        members: { cache: members, fetch: async (id?: string) => (id ? members.get(id) : members) },
        roles: { cache: roles },
        emojis: { cache: emojis },
        channels: {
            cache: channels,
            fetch: async (id: string) => channels.get(id)
                ? { ...channels.get(id), send: async () => ({ id: 'M_NEW' }), messages: { fetch: async () => ({ edit: async (o: any) => counterEdits.push(o) }) } }
                : null,
        },
    };

    // ── Mensajes con reacciones (roles por reacción) ──
    const BOT_ID = 'BOT';
    const botUser = { id: BOT_ID, username: 'KB Bot', bot: true, displayAvatarURL: () => '' };
    const messages = new Map<string, any>();
    const reactLog: string[] = [];
    const deletedMessages: string[] = [];
    const parseEmoji = (e: string) => {
        const m = /^<a?:(\w+):(\d+)>$/.exec(e);
        return m ? { id: m[2], name: m[1] } : { id: null, name: e };
    };
    const mkMessage = (id: string, channelId: string) => {
        const reactions = new Collection<string, any>();
        const msg: any = {
            id, channelId, guildId, guild, partial: false,
            edit: async (o: any) => { counterEdits.push(o); return msg; },
            delete: async () => { messages.delete(id); deletedMessages.push(id); },
            fetch: async () => msg,
            reactions: { cache: reactions },
            react: async (e: string) => { const r = msg.reaction(e); r.userIds.add(BOT_ID); r.me = true; reactLog.push(`${id}:${e}`); return r; },
            reaction: (e: string) => {
                const emoji = parseEmoji(e);
                const key = emoji.id ?? emoji.name!;
                let r = reactions.get(key);
                if (!r) {
                    r = {
                        emoji, me: false, message: msg, userIds: new Set<string>(),
                        users: {
                            remove: async (uid: string) => {
                                if (!r.userIds.delete(uid)) return;
                                if (uid === BOT_ID) r.me = false;
                                reactLog.push(`-${id}:${e}:${uid}`);
                                client.emit('messageReactionRemove', r, uid === BOT_ID ? botUser : users.get(uid));
                            },
                        },
                    };
                    reactions.set(key, r);
                }
                return r;
            },
        };
        messages.set(id, msg);
        return msg;
    };
    const getMessage = (id: string, channelId = 'C1') => messages.get(id) ?? mkMessage(id, channelId);
    /** Simula que un usuario reacciona o quita su reacción. */
    const userReact = (messageId: string, emoji: string, userId: string, add = true) => {
        const r = getMessage(messageId).reaction(emoji);
        if (add) r.userIds.add(userId); else r.userIds.delete(userId);
        client.emit(add ? 'messageReactionAdd' : 'messageReactionRemove', r, users.get(userId));
    };
    let sentCount = 0;

    const client: any = new EventEmitter();
    Object.assign(client, {
        user: botUser,
        isReady: () => true,
        ws: { ping: 38 },
        guilds: { cache: new Collection([[guildId, guild]]) },
        users: {
            fetch: async (id: string) => users.get(id) ?? (id.startsWith('X')
                ? (() => { throw Object.assign(new Error('Unknown User'), { code: 10013 }); })()
                : mkUser(id, `user-${id}`)),
        },
        channels: {
            fetch: async (id: string) => {
                const c = channels.get(id);
                if (!c) return null;
                return {
                    ...c,
                    send: async (o: any) => { channelsSent.push(o); return mkMessage(`cm${++sentCount}`, id); },
                    messages: {
                        fetch: async (mid: string) => {
                            if (mid.startsWith('9')) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
                            return getMessage(mid, id);
                        },
                    },
                };
            },
        },
    });

    return {
        client, guild, members, roles, channels, users, sent, roleLog, nickLog, channelsSent, counterEdits, reactLog, deletedMessages,
        mkUser, addMember, addRole, addChannel, addEmoji, getMessage, userReact,
    };
}
