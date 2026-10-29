import { EmbedBuilder, type Client, type Guild } from 'discord.js';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { ConfirmationService } from '../confirmations/service';
import { queryServer, type PlayerInfo, type QueryResult, type ServerKind } from './query';

const logger = new Logger('ServersService');

const INTERVAL_KEY = 'servers.interval_sec';
export const MIN_INTERVAL = 10;
export const MAX_INTERVAL = 3600;

interface GameServerRow {
    id: number;
    name: string;
    type: ServerKind;
    host: string;
    port: number | null;
    api_port: number | null;
    enabled: number;
    link_players: number;
    channel_id: string | null;
    message_id: string | null;
    created_at: number;
}

export interface GameServer {
    id: number;
    name: string;
    type: ServerKind;
    host: string;
    port: number | null;
    apiPort: number | null;
    enabled: boolean;
    linkPlayers: boolean;
    channelId: string | null;
    messageId: string | null;
    createdAt: number;
}

export type GameServerInput = Pick<GameServer, 'name' | 'type' | 'host' | 'port' | 'apiPort' | 'enabled' | 'linkPlayers'>;

export interface LinkedPlayer extends PlayerInfo {
    /** Usuario de Discord asociado (por la respuesta que dio en una campaña de confirmación). */
    discordId: string | null;
    discordName: string | null;
}

export interface ServerStatus extends Omit<QueryResult, 'players'> {
    serverId: number;
    players: LinkedPlayer[];
    /** Último error al actualizar el mensaje de estado en Discord. */
    messageError: string | null;
}

const toServer = (r: GameServerRow): GameServer => ({
    id: r.id,
    name: r.name,
    type: r.type,
    host: r.host,
    port: r.port,
    apiPort: r.api_port,
    enabled: !!r.enabled,
    linkPlayers: !!r.link_players,
    channelId: r.channel_id,
    messageId: r.message_id,
    createdAt: r.created_at,
});

const TYPE_LABEL: Record<ServerKind, string> = { minecraft: 'Minecraft', hytale: 'Hytale' };

const SQ = { GREEN: '🟩', YELLOW: '🟨', RED: '🟥', EMPTY: '⬛' };
const tpsColor = (tps: number) => (tps >= 15 ? SQ.GREEN : tps >= 10 ? SQ.YELLOW : SQ.RED);

/** Barra de ocupación (máx. 20 casillas, para no pasarse del límite de Discord con servidores grandes). */
function playersBar(online: number, max: number): string {
    if (max <= 0) return '';
    const cells = Math.min(max, 20);
    const full = Math.min(cells, Math.round((online / max) * cells));
    const ratio = online / max;
    const color = ratio <= 0.5 ? SQ.GREEN : ratio < 1 ? SQ.YELLOW : SQ.RED;
    return color.repeat(full) + SQ.EMPTY.repeat(cells - full);
}

/** Une líneas hasta el límite de un campo de embed (1024) y añade "…y N más". */
function fitLines(lines: string[], limit = 1000): string {
    let out = '';
    let shown = 0;
    for (const l of lines) {
        if (out.length + l.length + 1 > limit) break;
        out += `${l}\n`;
        shown++;
    }
    if (shown < lines.length) out += `*…y ${lines.length - shown} más*`;
    return out.trim();
}

export class ServersService {
    private readonly statuses = new Map<number, ServerStatus>();
    private timer: NodeJS.Timeout | undefined;
    private polling = false;
    active = false;

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly confirmations: ConfirmationService
    ) {}

    private guild(): Guild | undefined {
        return this.client.guilds.cache.get(env.guildId);
    }

    // ────────────────────────── CRUD ──────────────────────────

    list(): GameServer[] {
        return (this.db.prepare('SELECT * FROM game_servers ORDER BY id').all() as GameServerRow[]).map(toServer);
    }

    get(id: number): GameServer | null {
        const row = this.db.prepare('SELECT * FROM game_servers WHERE id = ?').get(id) as GameServerRow | undefined;
        return row ? toServer(row) : null;
    }

    require(id: number): GameServer {
        const s = this.get(id);
        if (!s) throw new HttpError(404, 'Servidor no encontrado');
        return s;
    }

    create(input: GameServerInput): GameServer {
        const res = this.db.prepare(`
            INSERT INTO game_servers (name, type, host, port, api_port, enabled, link_players, created_at)
            VALUES (@name, @type, @host, @port, @apiPort, @enabled, @linkPlayers, @createdAt)
        `).run({ ...this.params(input), createdAt: Date.now() });
        const s = this.require(Number(res.lastInsertRowid));
        publish('servers:changed', { id: s.id });
        if (this.active && s.enabled) void this.check(s.id);
        return s;
    }

    update(id: number, input: GameServerInput): GameServer {
        this.require(id);
        this.db.prepare(`
            UPDATE game_servers SET name=@name, type=@type, host=@host, port=@port, api_port=@apiPort,
                enabled=@enabled, link_players=@linkPlayers
            WHERE id=@id
        `).run({ ...this.params(input), id });
        const s = this.require(id);
        if (!s.enabled) this.statuses.delete(id);
        publish('servers:changed', { id });
        if (this.active && s.enabled) void this.check(id);
        return s;
    }

    delete(id: number): void {
        const res = this.db.prepare('DELETE FROM game_servers WHERE id = ?').run(id);
        if (!res.changes) throw new HttpError(404, 'Servidor no encontrado');
        this.statuses.delete(id);
        publish('servers:changed', { id });
    }

    private params(i: GameServerInput) {
        return {
            name: i.name,
            type: i.type,
            host: i.host,
            port: i.port,
            apiPort: i.apiPort,
            enabled: i.enabled ? 1 : 0,
            linkPlayers: i.linkPlayers ? 1 : 0,
        };
    }

    // ────────────────────────── Sondeo ──────────────────────────

    intervalSec(): number {
        const n = Number(getSetting(this.db, INTERVAL_KEY, '30'));
        return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), MIN_INTERVAL), MAX_INTERVAL) : 30;
    }

    setIntervalSec(sec: number): number {
        setSetting(this.db, INTERVAL_KEY, String(sec));
        if (this.active) this.schedule();
        publish('servers:changed', {});
        return this.intervalSec();
    }

    start(): void {
        this.active = true;
        this.schedule();
        void this.pollAll();
    }

    stop(): void {
        this.active = false;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    private schedule(): void {
        clearInterval(this.timer);
        this.timer = setInterval(() => void this.pollAll(), this.intervalSec() * 1000);
    }

    /** Último estado conocido de un servidor (null si aún no se ha consultado). */
    statusOf(id: number): ServerStatus | null {
        return this.statuses.get(id) ?? null;
    }

    async pollAll(): Promise<void> {
        if (this.polling) return; // si una ronda tarda más que el intervalo, no se solapan
        this.polling = true;
        try {
            await Promise.all(this.list().filter(s => s.enabled).map(s => this.check(s.id).catch(err => logger.error(`Error consultando "${s.name}"`, err))));
        } finally {
            this.polling = false;
        }
    }

    /** Consulta un servidor ahora mismo, guarda el resultado y actualiza su mensaje de Discord. */
    async check(id: number): Promise<ServerStatus> {
        const server = this.require(id);
        const result = await queryServer(server);
        const prev = this.statuses.get(id);

        if (prev && prev.online !== result.online) {
            if (result.online) logger.info(`🟢 "${server.name}" vuelve a estar online`);
            else logger.warn(`🔴 "${server.name}" está offline: ${result.error}`);
        }

        const status: ServerStatus = {
            ...result,
            serverId: id,
            players: result.players.map(p => this.linkPlayer(server, p)),
            messageError: prev?.messageError ?? null,
        };

        if (server.channelId && server.messageId) {
            try {
                await this.editMessage(server, status);
                if (status.messageError) logger.info(`Mensaje de estado de "${server.name}" actualizado de nuevo`);
                status.messageError = null;
            } catch (err) {
                const msg = (err as Error).message;
                if (msg !== status.messageError) logger.warn(`No se pudo actualizar el mensaje de estado de "${server.name}": ${msg}`);
                status.messageError = msg;
            }
        } else {
            status.messageError = null;
        }

        this.statuses.set(id, status);
        publish('servers:status', status);
        return status;
    }

    private linkPlayer(server: GameServer, p: PlayerInfo): LinkedPlayer {
        if (!server.linkPlayers) return { ...p, discordId: null, discordName: null };
        const username = this.confirmations.usernameForAnswer(p.name) ?? p.name;
        const member = this.guild()?.members.cache.find(m => m.user.username === username);
        return { ...p, discordId: member?.id ?? null, discordName: member?.displayName ?? null };
    }

    // ────────────────────────── Mensaje de estado en Discord ──────────────────────────

    buildEmbed(server: GameServer, s: ServerStatus | null): EmbedBuilder {
        const interval = this.intervalSec();
        const footer = { text: `${TYPE_LABEL[server.type]} · se actualiza cada ${interval < 60 ? `${interval} s` : `${Math.round(interval / 60)} min`}` };

        if (!s) {
            return new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 ${server.name}`).setDescription('**Consultando el servidor…**').setFooter(footer).setTimestamp();
        }

        if (!s.online) {
            return new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle(`🔴 ${server.name} · Offline`)
                .setDescription('El servidor no responde ahora mismo. Vuelve a mirar en un rato.')
                .setFooter(footer)
                .setTimestamp();
        }

        const embed = new EmbedBuilder()
            .setColor(0x00aaff)
            .setTitle(`📊 Estado de ${server.name}`)
            .setFooter(footer)
            .setTimestamp();

        const info = [`🟢 **Online**${s.latencyMs !== null ? ` · ${s.latencyMs} ms` : ''}`];
        if (s.version) info.push(`🏷️ ${s.version}`);
        embed.setDescription(info.join('\n'));

        if (s.tps) {
            embed.addFields({
                name: '⚡ TPS',
                value:
                    `${tpsColor(s.tps.s10)} 10s: **${s.tps.s10.toFixed(2)}**\n` +
                    `${tpsColor(s.tps.m1)} 1m: **${s.tps.m1.toFixed(2)}**\n` +
                    `${tpsColor(s.tps.m5)} 5m: **${s.tps.m5.toFixed(2)}**\n` +
                    `${tpsColor(s.tps.m15)} 15m: **${s.tps.m15.toFixed(2)}**`,
                inline: true,
            });
        }
        if (s.msptMs !== null || s.cpu !== null) {
            const lines: string[] = [];
            if (s.msptMs !== null) lines.push(`• MSPT: **${s.msptMs.toFixed(2)} ms**`);
            if (s.cpu !== null) lines.push(`• CPU: **${(s.cpu * 100).toFixed(0)}%**`);
            embed.addFields({ name: '🖥️ Rendimiento', value: lines.join('\n'), inline: true });
        }

        embed.addFields({
            name: `👥 Jugadores (${s.playersOnline}/${s.maxPlayers})`,
            value: playersBar(s.playersOnline, s.maxPlayers) || '​',
        });

        const lines = s.players.map(p => (server.linkPlayers ? `${p.name} (${p.discordId ? `<@${p.discordId}>` : '???'})` : p.name));
        const hidden = s.playersOnline - s.players.length;
        if (hidden > 0) lines.push(`*…y ${hidden} más*`);
        embed.addFields({
            name: '🧑‍🚀 Lista de jugadores',
            value: lines.length ? fitLines(lines) : '*No hay jugadores conectados*',
        });
        return embed;
    }

    private async fetchStatusMessage(server: GameServer) {
        const channel = await this.client.channels.fetch(server.channelId!).catch(() => null);
        if (!channel || !('messages' in channel)) throw new Error('el canal ya no existe o no es de texto');
        const message = await channel.messages.fetch(server.messageId!).catch(() => null);
        if (!message) throw new Error('el mensaje ya no existe (créalo de nuevo desde el panel)');
        return message;
    }

    private async editMessage(server: GameServer, s: ServerStatus): Promise<void> {
        const message = await this.fetchStatusMessage(server);
        await message.edit({ embeds: [this.buildEmbed(server, s)] });
    }

    /** Publica un mensaje de estado nuevo en un canal y lo deja enlazado al servidor. */
    async createMessage(id: number, channelId: string): Promise<GameServer> {
        const server = this.require(id);
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('send' in channel)) throw new HttpError(400, 'Ese canal no admite mensajes.');
        const sent = await (channel as { send: (o: unknown) => Promise<{ id: string }> })
            .send({ embeds: [this.buildEmbed(server, this.statuses.get(id) ?? null)] })
            .catch(err => { throw new HttpError(400, `No se pudo publicar en el canal: ${(err as Error).message}`); });
        this.db.prepare('UPDATE game_servers SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, sent.id, id);
        const updated = this.require(id);
        publish('servers:changed', { id });
        if (this.active && updated.enabled) void this.check(id).catch(() => undefined);
        return updated;
    }

    /** Olvida el mensaje de estado (no lo borra de Discord). */
    unlinkMessage(id: number): GameServer {
        this.require(id);
        this.db.prepare('UPDATE game_servers SET channel_id = NULL, message_id = NULL WHERE id = ?').run(id);
        const s = this.statuses.get(id);
        if (s) s.messageError = null;
        publish('servers:changed', { id });
        return this.require(id);
    }
}
