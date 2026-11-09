import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { queryFull } from 'minecraft-server-util';
import { clean as cleanMotd, parse as parseMotd } from 'minecraft-motd-util';

export type ServerKind = 'minecraft' | 'hytale';

export interface QueryTarget {
    type: ServerKind;
    host: string;
    /** Puerto del juego (solo Minecraft; 25565 si se deja vacío). */
    port: number | null;
    /** Minecraft: API de métricas (Spark) para TPS/MSPT/CPU. Hytale: API Nitrado Query (obligatoria). */
    apiPort: number | null;
}

export interface PlayerInfo {
    name: string;
    id?: string;
}

export interface QueryResult {
    online: boolean;
    checkedAt: number;
    latencyMs: number | null;
    error: string | null;
    version: string | null;
    motd: string | null;
    playersOnline: number;
    maxPlayers: number;
    players: PlayerInfo[];
    /** false si solo tenemos una muestra parcial de jugadores (Minecraft sin "enable-query"). */
    playerListComplete: boolean;
    tps: { s10: number; m1: number; m5: number; m15: number } | null;
    msptMs: number | null;
    /** 0..1 */
    cpu: number | null;
    /** Avisos no graves (p. ej. la API de métricas no responde, pero el servidor sí). */
    warnings: string[];
}

const TIMEOUT = 5000;
/** La consulta UDP (lista completa de jugadores) suele no estar activada: no esperamos tanto por ella. */
const QUERY_TIMEOUT = 2500;

/** Traduce los errores de red a algo legible en el panel. */
export function friendlyNetError(err: unknown): string {
    const e = err as { code?: string; message?: string; name?: string };
    const code = e?.code ?? '';
    const msg = e?.message ?? String(err);
    if (code === 'ECONNREFUSED') return 'Conexión rechazada (¿servidor apagado o puerto incorrecto?)';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'No se encuentra el host';
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host inalcanzable';
    if (code === 'ECONNRESET') return 'La conexión se cortó';
    if (e?.name === 'TimeoutError' || /timed? ?out/i.test(msg)) return 'Sin respuesta (tiempo de espera agotado)';
    return msg;
}

function offline(error: string, latencyMs: number | null = null): QueryResult {
    return {
        online: false, checkedAt: Date.now(), latencyMs, error, version: null, motd: null,
        playersOnline: 0, maxPlayers: 0, players: [], playerListComplete: true,
        tps: null, msptMs: null, cpu: null, warnings: [],
    };
}

// ───────────────────────────── Minecraft ─────────────────────────────

interface SparkMetrics {
    tps_10s: number;
    tps_1m: number;
    tps_5m: number;
    tps_15m: number;
    mspt_1m: number;
    cpu: number;
}

async function fetchSpark(host: string, apiPort: number): Promise<SparkMetrics> {
    const res = await fetch(`http://${host}:${apiPort}/metrics`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as SparkMetrics;
    if (typeof d?.tps_1m !== 'number') throw new Error('respuesta sin TPS');
    return d;
}

// Cliente propio de Server List Ping (https://wiki.vg/Server_List_Ping). El de minecraft-server-util no respeta la
// longitud del paquete: si un mod (p. ej. en Forge/NeoForge) añade datos tras el JSON, los lee como si fueran el
// "pong" y falla ("Expected server to send packet type 0x01..."). Aquí se salta lo que sobre y el pong es opcional:
// solo sirve para medir la latencia.

interface SlpStatus {
    version?: { name?: string };
    players?: { online?: number; max?: number; sample?: Array<{ name: string; id: string }> | null };
    description?: unknown;
}

/** Tras recibir el estado, cuánto esperamos al pong antes de quedarnos con la latencia de la respuesta de estado. */
const PONG_TIMEOUT = 1500;

function writeVarInt(n: number): Buffer {
    const out: number[] = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return Buffer.from(out);
}

/** Lee un VarInt; null si aún no han llegado bytes suficientes. */
function readVarInt(buf: Buffer, off: number): { value: number; next: number } | null {
    let v = 0;
    for (let i = 0; i < 5; i++) {
        if (off + i >= buf.length) return null;
        const b = buf[off + i];
        v |= (b & 0x7f) << (7 * i);
        if (!(b & 0x80)) return { value: v, next: off + i + 1 };
    }
    throw new Error('Respuesta no válida (VarInt demasiado largo)');
}

function mcPacket(id: number, payload: Buffer): Buffer {
    const body = Buffer.concat([writeVarInt(id), payload]);
    return Buffer.concat([writeVarInt(body.length), body]);
}

/** Extrae el siguiente paquete completo del búfer, o null si está incompleto. */
function takePacket(buf: Buffer): { id: number; body: Buffer; rest: Buffer } | null {
    const len = readVarInt(buf, 0);
    if (!len || buf.length < len.next + len.value) return null;
    const pkt = buf.subarray(len.next, len.next + len.value);
    const id = readVarInt(pkt, 0);
    if (!id) throw new Error('Respuesta no válida (paquete vacío)');
    return { id: id.value, body: pkt.subarray(id.next), rest: buf.subarray(len.next + len.value) };
}

function pingStatus(host: string, port: number, timeout: number): Promise<{ data: SlpStatus; latencyMs: number }> {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host, port });
        let buf: Buffer = Buffer.alloc(0);
        let data: SlpStatus | null = null;
        let statusLatency = 0;
        let requestAt = 0;
        let pingAt = 0;
        let pongTimer: NodeJS.Timeout | undefined;
        let done = false;

        const finish = (err: Error | null, latencyMs = 0) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(pongTimer);
            sock.destroy();
            if (err) reject(err);
            else resolve({ data: data!, latencyMs });
        };
        // Sin pong válido nos quedamos con el tiempo que tardó la respuesta de estado.
        const finishWithoutPong = () => finish(null, statusLatency);

        const timer = setTimeout(() => {
            if (data) finishWithoutPong();
            else finish(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        }, timeout);

        sock.on('connect', () => {
            const hostBuf = Buffer.from(host, 'utf8');
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(port);
            sock.write(mcPacket(0x00, Buffer.concat([writeVarInt(47), writeVarInt(hostBuf.length), hostBuf, portBuf, writeVarInt(1)])));
            requestAt = Date.now();
            sock.write(mcPacket(0x00, Buffer.alloc(0)));
        });
        sock.on('error', err => (data ? finishWithoutPong() : finish(err)));
        sock.on('close', () => (data ? finishWithoutPong() : finish(new Error('El servidor cerró la conexión sin responder'))));
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            try {
                const pkt = takePacket(buf);
                if (!pkt) return;
                buf = pkt.rest;
                if (!data) {
                    if (pkt.id !== 0x00) throw new Error(`Respuesta no válida (paquete ${pkt.id} en vez del estado)`);
                    const str = readVarInt(pkt.body, 0);
                    if (!str || str.next + str.value > pkt.body.length) throw new Error('Respuesta no válida (estado incompleto)');
                    // Lo que haya tras el JSON (datos extra de mods) se ignora.
                    data = JSON.parse(pkt.body.subarray(str.next, str.next + str.value).toString('utf8')) as SlpStatus;
                    statusLatency = Date.now() - requestAt;
                    const payload = Buffer.alloc(8);
                    payload.writeBigInt64BE(BigInt(Date.now()));
                    pingAt = Date.now();
                    sock.write(mcPacket(0x01, payload));
                    pongTimer = setTimeout(finishWithoutPong, PONG_TIMEOUT);
                } else if (pkt.id === 0x01) {
                    finish(null, Date.now() - pingAt);
                } else {
                    finishWithoutPong();
                }
            } catch (err) {
                if (data) finishWithoutPong();
                else finish(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
}

/** Como el cliente de Minecraft: si no se indica puerto, se mira el registro SRV _minecraft._tcp del dominio. */
async function resolveMinecraftAddress(host: string, port: number | null): Promise<{ host: string; port: number }> {
    if (port !== null || net.isIP(host)) return { host, port: port ?? 25565 };
    try {
        const [srv] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
        if (srv) return { host: srv.name, port: srv.port };
    } catch { /* sin registro SRV */ }
    return { host, port: 25565 };
}

function motdText(description: unknown): string | null {
    if (description == null) return null;
    try {
        return cleanMotd(parseMotd(description as Parameters<typeof parseMotd>[0])).trim() || null;
    } catch {
        return typeof description === 'string' ? description.trim() || null : null;
    }
}

async function queryMinecraft(t: QueryTarget): Promise<QueryResult> {
    const { host, port } = await resolveMinecraftAddress(t.host, t.port);
    // Las tres consultas van en paralelo, pero si el ping falla respondemos "offline" sin esperar a las otras.
    const settle = <T,>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), reason => ({ ok: false as const, reason }));
    const qP = settle(queryFull(host, port, { timeout: QUERY_TIMEOUT }));
    const sparkP = settle(t.apiPort ? fetchSpark(t.host, t.apiPort) : Promise.reject(null));

    let s: SlpStatus;
    let latencyMs: number;
    try {
        ({ data: s, latencyMs } = await pingStatus(host, port, TIMEOUT));
    } catch (err) {
        return offline(friendlyNetError(err));
    }
    const [q, spark] = await Promise.all([qP, sparkP]);
    const warnings: string[] = [];

    // La lista completa solo llega por "query" (enable-query=true en server.properties); si no, usamos la muestra del ping.
    let players: PlayerInfo[];
    let complete: boolean;
    if (q.ok) {
        players = q.value.players.list.map(name => ({ name }));
        complete = true;
    } else {
        players = (s.players?.sample ?? []).map(p => ({ name: p.name, id: p.id }));
        complete = players.length >= (s.players?.online ?? 0);
    }

    let tps: QueryResult['tps'] = null;
    let msptMs: number | null = null;
    let cpu: number | null = null;
    if (spark.ok) {
        const m = spark.value;
        tps = { s10: m.tps_10s, m1: m.tps_1m, m5: m.tps_5m, m15: m.tps_15m };
        msptMs = m.mspt_1m;
        cpu = m.cpu;
    } else if (t.apiPort) {
        warnings.push(`La API de métricas (puerto ${t.apiPort}) no responde: ${friendlyNetError(spark.reason)}`);
    }

    return {
        online: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        version: s.version?.name ?? null,
        motd: motdText(s.description),
        playersOnline: s.players?.online ?? 0,
        maxPlayers: s.players?.max ?? 0,
        players,
        playerListComplete: complete,
        tps, msptMs, cpu, warnings,
    };
}

// ───────────────────────────── Hytale (Nitrado Query) ─────────────────────────────

interface NitradoQuery {
    Server: { Name: string; Version: string; MaxPlayers: number };
    Players: Array<{ Name: string; UUID: string; World: string }>;
}

// El servidor de Hytale usa un certificado autofirmado: solo se relaja la verificación TLS en esta petición.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getJsonInsecure<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { agent: insecureAgent, timeout: TIMEOUT }, res => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T); } catch { reject(new Error('respuesta no válida')); }
            });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
        req.on('error', reject);
    });
}

async function queryHytale(t: QueryTarget): Promise<QueryResult> {
    if (!t.apiPort) return offline('Falta el puerto de la API (Nitrado Query)');
    const started = Date.now();
    try {
        const d = await getJsonInsecure<NitradoQuery>(`https://${t.host}:${t.apiPort}/Nitrado/Query`);
        const players = (d.Players ?? []).map(p => ({ name: p.Name, id: p.UUID }));
        return {
            online: true,
            checkedAt: Date.now(),
            latencyMs: Date.now() - started,
            error: null,
            version: d.Server?.Version ?? null,
            motd: d.Server?.Name ?? null,
            playersOnline: players.length,
            maxPlayers: d.Server?.MaxPlayers ?? 0,
            players,
            playerListComplete: true,
            tps: null, msptMs: null, cpu: null, warnings: [],
        };
    } catch (err) {
        return offline(friendlyNetError(err));
    }
}

export async function queryServer(t: QueryTarget): Promise<QueryResult> {
    try {
        return t.type === 'hytale' ? await queryHytale(t) : await queryMinecraft(t);
    } catch (err) {
        return offline(friendlyNetError(err));
    }
}
