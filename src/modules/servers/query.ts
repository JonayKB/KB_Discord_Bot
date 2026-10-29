import https from 'node:https';
import { queryFull, status } from 'minecraft-server-util';

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

async function queryMinecraft(t: QueryTarget): Promise<QueryResult> {
    const port = t.port ?? 25565;
    // Las tres consultas van en paralelo, pero si el ping falla respondemos "offline" sin esperar a las otras.
    const settle = <T,>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), reason => ({ ok: false as const, reason }));
    const qP = settle(queryFull(t.host, port, { timeout: QUERY_TIMEOUT }));
    const sparkP = settle(t.apiPort ? fetchSpark(t.host, t.apiPort) : Promise.reject(null));

    let s: Awaited<ReturnType<typeof status>>;
    try {
        s = await status(t.host, port, { timeout: TIMEOUT });
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
        players = (s.players.sample ?? []).map(p => ({ name: p.name, id: p.id }));
        complete = players.length >= s.players.online;
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
        latencyMs: s.roundTripLatency,
        error: null,
        version: s.version.name,
        motd: s.motd.clean.trim() || null,
        playersOnline: s.players.online,
        maxPlayers: s.players.max,
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
