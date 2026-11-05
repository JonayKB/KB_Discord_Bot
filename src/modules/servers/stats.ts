import crypto from 'node:crypto';
import { Cron } from 'croner';
import { MessageFlags, type Client, type Interaction } from 'discord.js';
import type { DB } from '../../core/db';
import { getSetting, setSetting } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import { LEADERBOARD_PREFIX, PERIODS, STAT_KEYS, parseLeaderboardControl, renderRanking, sortRows, type Period, type RankRow, type RankingMessage, type StatKey, type Stats } from './ranking';

const logger = new Logger('McStats');

/**
 * Estadísticas de jugadores que envía el mod kb_discord_auth y rankings en Discord.
 * Contrato: kb_discord_auth/docs/stats-contract.md (versión 1).
 */

export const CONTRACT_VERSION = 1;
export const INGEST_PATH = '/api/integrations/minecraft/stats';
export const MAX_PLAYERS_PER_REQUEST = 500;
/** stats.intervalMinutes por defecto del mod. */
const MOD_INTERVAL_MS = 5 * 60_000;
/** Sin envíos en más de 3 intervalos → aviso en el ranking. */
export const STALE_MS = 3 * MOD_INTERVAL_MS;
/** Semanas de bases semanales que se conservan. */
const KEEP_WEEKS = 8;
const WEEK_KEY = 'mcstats.week_start';

// ────────────────────────── Semana (lunes 00:00 en TIMEZONE) ──────────────────────────

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante `ts`. */
function tzOffset(ts: number, tz: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(ts).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Lunes 00:00 (en `tz`) de la semana que contiene `now`, en ms epoch. */
export function weekStartOf(now: number, tz = env.timezone): number {
    const local = new Date(now + tzOffset(now, tz));
    const daysSinceMonday = (local.getUTCDay() + 6) % 7;
    const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
    const first = midnight - tzOffset(midnight, tz);
    return midnight - tzOffset(first, tz); // segunda pasada por si el cambio de hora cae en medio
}

// ────────────────────────── Validación del cuerpo ──────────────────────────

export interface IngestPlayer {
    uuid: string;
    name: string;
    discordId: string | null;
    online: boolean;
    takenAt: number;
    stats: Stats;
}

export interface IngestPayload {
    version: number;
    server: { id: string; name: string };
    sentAt: number;
    players: IngestPlayer[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs de Discord (snowflakes); se admite cualquier texto alfanumérico corto para no romper una mención. */
const SNOWFLAKE_RE = /^\w{1,32}$/;

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTs = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Valida el cuerpo completo; cualquier fallo → 400 sin guardar nada. Ignora los campos desconocidos. */
export function parsePayload(body: unknown): IngestPayload {
    if (!isObj(body)) return bad('el cuerpo debe ser un objeto JSON');
    if (body.version !== CONTRACT_VERSION) return bad(`versión del contrato no soportada: ${JSON.stringify(body.version)} (se admite ${CONTRACT_VERSION})`);

    const server = body.server;
    if (!isObj(server)) return bad('falta "server"');
    if (typeof server.id !== 'string' || server.id.length > 64) return bad('"server.id" no válido');
    const serverName = typeof server.name === 'string' ? server.name.trim() : '';
    if (!serverName || serverName.length > 64) return bad('"server.name" debe tener entre 1 y 64 caracteres');
    if (!isTs(body.sentAt)) return bad('"sentAt" debe ser un entero (ms epoch)');

    const list = body.players;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PLAYERS_PER_REQUEST) return bad(`"players" debe tener entre 1 y ${MAX_PLAYERS_PER_REQUEST} jugadores`);

    const players = list.map((p, i): IngestPlayer => {
        const at = `players[${i}]`;
        if (!isObj(p)) return bad(`${at} no es un objeto`);
        if (typeof p.uuid !== 'string' || !UUID_RE.test(p.uuid)) return bad(`${at}.uuid no es un UUID`);
        const nameLen = typeof p.name === 'string' ? [...p.name].length : 0;
        if (nameLen < 1 || nameLen > 16) return bad(`${at}.name debe tener entre 1 y 16 caracteres`);
        if (p.discordId !== undefined && p.discordId !== null && (typeof p.discordId !== 'string' || !SNOWFLAKE_RE.test(p.discordId))) return bad(`${at}.discordId no es un ID de Discord`);
        if (p.online !== undefined && typeof p.online !== 'boolean') return bad(`${at}.online debe ser booleano`);
        if (!isTs(p.takenAt)) return bad(`${at}.takenAt debe ser un entero (ms epoch)`);
        if (!isObj(p.stats)) return bad(`${at}.stats debe ser un objeto`);

        const stats: Stats = {};
        for (const key of STAT_KEYS) {
            const v = p.stats[key];
            if (v === undefined || v === null) continue; // sin dato
            if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return bad(`${at}.stats.${key} debe ser un entero ≥ 0`);
            stats[key] = v;
        }
        return {
            uuid: p.uuid.toLowerCase(),
            name: p.name as string,
            discordId: (p.discordId as string | null | undefined) ?? null,
            online: p.online === true,
            takenAt: p.takenAt as number,
            stats,
        };
    });

    return { version: CONTRACT_VERSION, server: { id: server.id, name: serverName }, sentAt: body.sentAt as number, players };
}

// ────────────────────────── Tipos ──────────────────────────

interface PlayerRow {
    server_id: number;
    uuid: string;
    name: string;
    discord_id: string | null;
    taken_at: number;
    stats: string;
    updated_at: number;
    base: string | null;
}

export interface PlayerStats {
    uuid: string;
    name: string;
    discordId: string | null;
    takenAt: number;
    updatedAt: number;
    total: Stats;
    weekly: Stats;
}

interface LeaderboardRow {
    id: number;
    server_id: number;
    enabled: number;
    channel_id: string;
    message_id: string | null;
    stats: string;
    periods: string;
    top: number;
    interval_min: number;
    title: string;
    linked_only: number;
    exclude: string;
    last_posted_at: number | null;
    last_error: string | null;
    created_at: number;
}

export interface Leaderboard {
    id: number;
    serverId: number;
    enabled: boolean;
    channelId: string;
    messageId: string | null;
    stats: StatKey[];
    periods: Period[];
    top: number;
    intervalMin: number;
    title: string;
    linkedOnly: boolean;
    exclude: string[];
    lastPostedAt: number | null;
    lastError: string | null;
    createdAt: number;
}

export type LeaderboardInput = Pick<Leaderboard, 'enabled' | 'channelId' | 'stats' | 'periods' | 'top' | 'intervalMin' | 'title' | 'linkedOnly' | 'exclude'>;

export interface StatsOverview {
    endpoint: string;
    key: { configured: boolean; createdAt: number | null };
    displayName: string | null;
    lastPushAt: number | null;
    stale: boolean;
    weekStart: number;
    timezone: string;
    players: PlayerStats[];
    leaderboards: Leaderboard[];
}

const toLeaderboard = (r: LeaderboardRow): Leaderboard => ({
    id: r.id,
    serverId: r.server_id,
    enabled: !!r.enabled,
    channelId: r.channel_id,
    messageId: r.message_id,
    stats: parseJson<StatKey[]>(r.stats, [...STAT_KEYS]).filter(k => STAT_KEYS.includes(k)),
    periods: parseJson<Period[]>(r.periods, [...PERIODS]).filter(p => PERIODS.includes(p)),
    top: r.top,
    intervalMin: r.interval_min,
    title: r.title,
    linkedOnly: !!r.linked_only,
    exclude: parseJson<string[]>(r.exclude, []),
    lastPostedAt: r.last_posted_at,
    lastError: r.last_error,
    createdAt: r.created_at,
});

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

/** semanal = max(0, total − base) por estadística; sin base → 0 (no se sabe qué hizo antes). */
function weeklyOf(total: Stats, base: Stats | null): Stats {
    const out: Stats = {};
    for (const k of STAT_KEYS) {
        const t = total[k];
        if (t === undefined) continue;
        const b = base?.[k] ?? t;
        out[k] = Math.max(0, t - b);
    }
    return out;
}

// ────────────────────────── Servicio ──────────────────────────

export class McStatsService {
    private cron: Cron | undefined;
    private timer: NodeJS.Timeout | undefined;
    private readonly publishing = new Set<number>();
    active = false;

    constructor(private readonly client: Client, private readonly db: DB) {}

    start(): void {
        this.active = true;
        this.ensureWeek();
        // Lunes 00:00: copia los totales como base de la semana.
        this.cron = new Cron('0 0 * * 1', { timezone: env.timezone }, () => {
            try { this.ensureWeek(); } catch (err) { logger.error('No se pudo guardar la base semanal', err); }
            void this.publishDue(true);
        });
        this.timer = setInterval(() => void this.publishDue(), 60_000);
        setTimeout(() => void this.publishDue(), 5_000).unref();
    }

    stop(): void {
        this.active = false;
        this.cron?.stop();
        this.cron = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    endpoint(): string {
        return `${env.panel.url}${INGEST_PATH}`;
    }

    // ────────────────────────── API keys ──────────────────────────

    /** Genera (o regenera) la key de un servidor. Se devuelve una sola vez; la anterior deja de valer. */
    generateKey(serverId: number): string {
        const key = `kbs_${crypto.randomBytes(32).toString('base64url')}`;
        this.db.prepare(`
            INSERT INTO mc_stats_keys (server_id, key_hash, created_at) VALUES (?, ?, ?)
            ON CONFLICT(server_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at
        `).run(serverId, sha256(key).toString('hex'), Date.now());
        publish('mcstats:changed', { serverId });
        return key;
    }

    revokeKey(serverId: number): void {
        this.db.prepare('DELETE FROM mc_stats_keys WHERE server_id = ?').run(serverId);
        publish('mcstats:changed', { serverId });
    }

    /** Servidor al que pertenece una key (comparación en tiempo constante), o null. */
    serverForKey(key: string): number | null {
        const hash = sha256(key);
        let found: number | null = null;
        for (const row of this.db.prepare('SELECT server_id, key_hash FROM mc_stats_keys').all() as Array<{ server_id: number; key_hash: string }>) {
            const stored = Buffer.from(row.key_hash, 'hex');
            if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash)) found = row.server_id;
        }
        return found;
    }

    // ────────────────────────── Semana ──────────────────────────

    /** Si ha empezado una semana nueva, guarda los totales actuales como base (idempotente). */
    ensureWeek(now = Date.now()): number {
        const ws = weekStartOf(now);
        if (Number(getSetting(this.db, WEEK_KEY, '0')) === ws) return ws;
        this.db.transaction(() => {
            this.db.prepare(`
                INSERT OR IGNORE INTO mc_stats_weekly_base (server_id, week_start, uuid, stats)
                SELECT server_id, ?, uuid, stats FROM mc_stats_players
            `).run(ws);
            this.db.prepare('DELETE FROM mc_stats_weekly_base WHERE week_start < ?').run(ws - KEEP_WEEKS * 7 * 86_400_000);
            setSetting(this.db, WEEK_KEY, String(ws));
        })();
        logger.info(`📅 Nueva semana de estadísticas: ${new Date(ws).toISOString()}`);
        return ws;
    }

    // ────────────────────────── Recepción ──────────────────────────

    /** Guarda un envío del mod. Los datos con un takenAt igual o anterior al guardado se ignoran. */
    ingest(serverId: number, payload: IngestPayload, now = Date.now()): { accepted: number; ignored: number } {
        const ws = this.ensureWeek(now);
        const getPlayer = this.db.prepare('SELECT taken_at, stats FROM mc_stats_players WHERE server_id = ? AND uuid = ?');
        const upsert = this.db.prepare(`
            INSERT INTO mc_stats_players (server_id, uuid, name, discord_id, taken_at, stats, updated_at)
            VALUES (@serverId, @uuid, @name, @discordId, @takenAt, @stats, @now)
            ON CONFLICT(server_id, uuid) DO UPDATE SET name = excluded.name, discord_id = excluded.discord_id,
                taken_at = excluded.taken_at, stats = excluded.stats, updated_at = excluded.updated_at
        `);
        const getBase = this.db.prepare('SELECT stats FROM mc_stats_weekly_base WHERE server_id = ? AND week_start = ? AND uuid = ?');
        const setBase = this.db.prepare(`
            INSERT INTO mc_stats_weekly_base (server_id, week_start, uuid, stats) VALUES (?, ?, ?, ?)
            ON CONFLICT(server_id, week_start, uuid) DO UPDATE SET stats = excluded.stats
        `);

        let accepted = 0;
        let ignored = 0;
        this.db.transaction(() => {
            this.db.prepare('UPDATE game_servers SET mc_display_name = ?, mc_last_push_at = ? WHERE id = ?').run(payload.server.name, now, serverId);
            for (const p of payload.players) {
                const prev = getPlayer.get(serverId, p.uuid) as { taken_at: number; stats: string } | undefined;
                if (prev && prev.taken_at >= p.takenAt) { ignored++; continue; }

                // Las estadísticas que no vienen son "sin dato": se conserva el último valor conocido.
                const total: Stats = { ...parseJson<Stats>(prev?.stats, {}), ...p.stats };
                upsert.run({ serverId, uuid: p.uuid, name: p.name, discordId: p.discordId, takenAt: p.takenAt, stats: JSON.stringify(total), now });

                const baseRow = getBase.get(serverId, ws, p.uuid) as { stats: string } | undefined;
                if (!baseRow) {
                    // Primer dato de la semana: sus totales son la base, así empieza en 0.
                    setBase.run(serverId, ws, p.uuid, JSON.stringify(total));
                } else {
                    const base = parseJson<Stats>(baseRow.stats, {});
                    let changed = false;
                    for (const k of STAT_KEYS) {
                        const t = total[k];
                        if (t === undefined) continue;
                        if (base[k] === undefined) { base[k] = t; changed = true; }          // estadística nueva a mitad de semana
                        else if (t < base[k]!) { base[k] = 0; changed = true; }              // se borró world/stats
                    }
                    if (changed) setBase.run(serverId, ws, p.uuid, JSON.stringify(base));
                }
                accepted++;
            }
        })();

        publish('mcstats:changed', { serverId });
        return { accepted, ignored };
    }

    // ────────────────────────── Consultas ──────────────────────────

    players(serverId: number): PlayerStats[] {
        const ws = this.ensureWeek();
        const rows = this.db.prepare(`
            SELECT p.*, b.stats AS base FROM mc_stats_players p
            LEFT JOIN mc_stats_weekly_base b ON b.server_id = p.server_id AND b.uuid = p.uuid AND b.week_start = ?
            WHERE p.server_id = ?
        `).all(ws, serverId) as PlayerRow[];
        return rows.map(r => {
            const total = parseJson<Stats>(r.stats, {});
            return {
                uuid: r.uuid,
                name: r.name,
                discordId: r.discord_id,
                takenAt: r.taken_at,
                updatedAt: r.updated_at,
                total,
                weekly: weeklyOf(total, r.base ? parseJson<Stats>(r.base, {}) : null),
            };
        });
    }

    deletePlayer(serverId: number, uuid: string): void {
        const res = this.db.prepare('DELETE FROM mc_stats_players WHERE server_id = ? AND uuid = ?').run(serverId, uuid.toLowerCase());
        if (!res.changes) throw new HttpError(404, 'Jugador no encontrado');
        this.db.prepare('DELETE FROM mc_stats_weekly_base WHERE server_id = ? AND uuid = ?').run(serverId, uuid.toLowerCase());
        publish('mcstats:changed', { serverId });
    }

    /** Filas ordenadas de un ranking (sin ceros ni jugadores sin dato). */
    ranking(serverId: number, key: StatKey, period: Period, opts: { linkedOnly?: boolean; exclude?: string[] } = {}, players = this.players(serverId)): RankRow[] {
        const excluded = new Set((opts.exclude ?? []).map(x => x.trim().toLowerCase()).filter(Boolean));
        const rows: RankRow[] = [];
        for (const p of players) {
            if (opts.linkedOnly && !p.discordId) continue;
            if (excluded.has(p.uuid) || excluded.has(p.name.toLowerCase())) continue;
            const value = (period === 'total' ? p.total : p.weekly)[key];
            if (value === undefined || value <= 0) continue;
            rows.push({ uuid: p.uuid, name: p.name, discordId: p.discordId, takenAt: p.takenAt, value });
        }
        return sortRows(rows);
    }

    serverInfo(serverId: number): { name: string; displayName: string | null; lastPushAt: number | null } | null {
        const row = this.db.prepare('SELECT name, mc_display_name, mc_last_push_at FROM game_servers WHERE id = ?').get(serverId) as
            { name: string; mc_display_name: string | null; mc_last_push_at: number | null } | undefined;
        return row ? { name: row.name, displayName: row.mc_display_name, lastPushAt: row.mc_last_push_at } : null;
    }

    isStale(lastPushAt: number | null, now = Date.now()): boolean {
        return lastPushAt === null || now - lastPushAt > STALE_MS;
    }

    overview(serverId: number): StatsOverview {
        const info = this.serverInfo(serverId);
        if (!info) throw new HttpError(404, 'Servidor no encontrado');
        const key = this.db.prepare('SELECT created_at FROM mc_stats_keys WHERE server_id = ?').get(serverId) as { created_at: number } | undefined;
        return {
            endpoint: this.endpoint(),
            key: { configured: !!key, createdAt: key?.created_at ?? null },
            displayName: info.displayName,
            lastPushAt: info.lastPushAt,
            stale: this.isStale(info.lastPushAt),
            weekStart: this.ensureWeek(),
            timezone: env.timezone,
            players: this.players(serverId),
            leaderboards: this.leaderboards(serverId),
        };
    }

    // ────────────────────────── Rankings (CRUD) ──────────────────────────

    leaderboards(serverId?: number): Leaderboard[] {
        const rows = serverId === undefined
            ? this.db.prepare('SELECT * FROM mc_leaderboards ORDER BY id').all()
            : this.db.prepare('SELECT * FROM mc_leaderboards WHERE server_id = ? ORDER BY id').all(serverId);
        return (rows as LeaderboardRow[]).map(toLeaderboard);
    }

    leaderboard(id: number, serverId?: number): Leaderboard {
        const row = this.db.prepare('SELECT * FROM mc_leaderboards WHERE id = ?').get(id) as LeaderboardRow | undefined;
        if (!row || (serverId !== undefined && row.server_id !== serverId)) throw new HttpError(404, 'Ranking no encontrado');
        return toLeaderboard(row);
    }

    private lbParams(i: LeaderboardInput) {
        return {
            enabled: i.enabled ? 1 : 0,
            channelId: i.channelId,
            stats: JSON.stringify(i.stats),
            periods: JSON.stringify(i.periods),
            top: i.top,
            intervalMin: i.intervalMin,
            title: i.title,
            linkedOnly: i.linkedOnly ? 1 : 0,
            exclude: JSON.stringify(i.exclude),
        };
    }

    createLeaderboard(serverId: number, input: LeaderboardInput): Leaderboard {
        const res = this.db.prepare(`
            INSERT INTO mc_leaderboards (server_id, enabled, channel_id, stats, periods, top, interval_min, title, linked_only, exclude, created_at)
            VALUES (@serverId, @enabled, @channelId, @stats, @periods, @top, @intervalMin, @title, @linkedOnly, @exclude, @now)
        `).run({ serverId, ...this.lbParams(input), now: Date.now() });
        publish('mcstats:changed', { serverId });
        return this.leaderboard(Number(res.lastInsertRowid));
    }

    updateLeaderboard(serverId: number, id: number, input: LeaderboardInput): Leaderboard {
        const prev = this.leaderboard(id, serverId);
        // Al cambiar de canal se publica un mensaje nuevo (el antiguo se deja como está).
        const messageId = prev.channelId === input.channelId ? prev.messageId : null;
        this.db.prepare(`
            UPDATE mc_leaderboards SET enabled=@enabled, channel_id=@channelId, stats=@stats, periods=@periods, top=@top,
                interval_min=@intervalMin, title=@title, linked_only=@linkedOnly, exclude=@exclude, message_id=@messageId,
                last_posted_at = NULL
            WHERE id=@id
        `).run({ ...this.lbParams(input), messageId, id });
        publish('mcstats:changed', { serverId });
        return this.leaderboard(id);
    }

    deleteLeaderboard(serverId: number, id: number): void {
        this.leaderboard(id, serverId);
        this.db.prepare('DELETE FROM mc_leaderboards WHERE id = ?').run(id);
        publish('mcstats:changed', { serverId });
    }

    // ────────────────────────── Publicación en Discord ──────────────────────────

    private inGuild = (id: string) => !!this.client.guilds.cache.get(env.guildId)?.members.cache.has(id);

    /**
     * Mensaje de un ranking. Sin `view` es el mensaje público (primera categoría y primer periodo);
     * con `view` es la vista privada de quien pulsa el menú o los botones.
     */
    render(lb: Leaderboard, view?: { stat: StatKey; period: Period; viewerId?: string }, now = Date.now()): RankingMessage {
        const info = this.serverInfo(lb.serverId);
        const serverName = info?.displayName ?? info?.name ?? 'Minecraft';
        const stat = view && lb.stats.includes(view.stat) ? view.stat : lb.stats[0];
        const period = view && lb.periods.includes(view.period) ? view.period : lb.periods[0];
        return renderRanking({
            leaderboardId: lb.id,
            title: lb.title.split('{server}').join(serverName),
            stats: lb.stats,
            periods: lb.periods,
            top: lb.top,
            stat,
            period,
            rows: this.ranking(lb.serverId, stat, period, lb),
            inGuild: this.inGuild,
            updatedAt: now,
            stale: this.isStale(info?.lastPushAt ?? null, now),
            viewerId: view?.viewerId,
        });
    }

    /**
     * Menú de categoría y botones de periodo. En el mensaje público se responde con una vista privada
     * (así nadie le cambia el ranking a los demás); en esa vista privada se actualiza ella misma.
     */
    async handleInteraction(i: Interaction): Promise<void> {
        if (!(i.isButton() || i.isStringSelectMenu()) || !i.customId.startsWith(LEADERBOARD_PREFIX)) return;
        const control = parseLeaderboardControl(i.customId, i.isStringSelectMenu() ? i.values : []);
        const lb = control ? this.leaderboards().find(x => x.id === control.id) : undefined;
        if (!control || !lb) {
            await i.reply({ content: 'Este ranking ya no existe.', flags: MessageFlags.Ephemeral });
            return;
        }
        const payload = { ...this.render(lb, { stat: control.stat, period: control.period, viewerId: i.user.id }), allowedMentions: { parse: [] as never[] } };
        if (i.message.flags.has(MessageFlags.Ephemeral)) await i.update(payload);
        else await i.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    /** Publica o edita el mensaje del ranking. Si el mensaje ya no existe, lo vuelve a publicar. */
    async publishLeaderboard(id: number): Promise<Leaderboard> {
        const lb = this.leaderboard(id);
        if (this.publishing.has(id)) return lb;
        this.publishing.add(id);
        try {
            const channel = await this.client.channels.fetch(lb.channelId).catch(() => null);
            if (!channel || !('send' in channel) || !('messages' in channel)) throw new Error('el canal ya no existe o no es de texto');
            const payload = { ...this.render(lb), allowedMentions: { parse: [] as never[] } };

            let messageId = lb.messageId;
            const existing = messageId
                ? await channel.messages.fetch(messageId).catch(err => {
                    if ((err as { code?: number }).code === 10008) return null; // Unknown Message → se publica otro
                    throw err;
                })
                : null;
            if (existing) await existing.edit(payload);
            else messageId = (await (channel as unknown as { send: (o: unknown) => Promise<{ id: string }> }).send(payload)).id;

            this.db.prepare('UPDATE mc_leaderboards SET message_id = ?, last_posted_at = ?, last_error = NULL WHERE id = ?').run(messageId, Date.now(), id);
            if (lb.lastError) logger.info(`Ranking #${id} actualizado de nuevo`);
        } catch (err) {
            const msg = (err as Error).message;
            if (msg !== lb.lastError) logger.warn(`No se pudo publicar el ranking #${id}: ${msg}`);
            // Se apunta la hora para no reintentar cada minuto: se vuelve a probar en el siguiente intervalo.
            this.db.prepare('UPDATE mc_leaderboards SET last_error = ?, last_posted_at = ? WHERE id = ?').run(msg, Date.now(), id);
        } finally {
            this.publishing.delete(id);
        }
        publish('mcstats:changed', { serverId: lb.serverId });
        return this.leaderboard(id);
    }

    /** Actualiza los rankings a los que les toca (o todos, con `force`). */
    async publishDue(force = false): Promise<void> {
        if (!this.active || !this.client.isReady()) return;
        const now = Date.now();
        for (const lb of this.leaderboards()) {
            if (!lb.enabled) continue;
            if (!force && lb.lastPostedAt !== null && now - lb.lastPostedAt < lb.intervalMin * 60_000) continue;
            await this.publishLeaderboard(lb.id).catch(err => logger.error(`Error en el ranking #${lb.id}`, err));
        }
    }
}
