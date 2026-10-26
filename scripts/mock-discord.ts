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

    const channels = new Collection<string, any>();
    const addChannel = (id: string, name: string) => channels.set(id, { id, name, type: ChannelType.GuildText, position: channels.size, parent: null });

    const guild: any = {
        id: guildId, name: 'MCKBServers', get memberCount() { return members.size; }, iconURL: () => null,
        members: { cache: members, fetch: async (id?: string) => (id ? members.get(id) : members) },
        roles: { cache: roles },
        channels: {
            cache: channels,
            fetch: async (id: string) => channels.get(id)
                ? { ...channels.get(id), send: async () => ({ id: 'M_NEW' }), messages: { fetch: async () => ({ edit: async (o: any) => counterEdits.push(o) }) } }
                : null,
        },
    };

    const client: any = new EventEmitter();
    Object.assign(client, {
        user: { username: 'KB Bot', displayAvatarURL: () => '' },
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
                    send: async (o: any) => { channelsSent.push(o); return { id: 'cm1' }; },
                    messages: { fetch: async () => ({ edit: async (o: any) => counterEdits.push(o) }) },
                };
            },
        },
    });

    return { client, guild, members, roles, channels, users, sent, roleLog, nickLog, channelsSent, counterEdits, mkUser, addMember, addRole, addChannel };
}
