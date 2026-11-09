/**
 * Latencia hasta el servidor medida desde varios lugares del mundo con Globalping (https://globalping.io),
 * un servicio gratuito con sondas repartidas por todo el planeta. La latencia que mide el bot no sirve:
 * el bot y el servidor de juego están en la misma red.
 */
import type { ServerKind } from './query';

const API = 'https://api.globalping.io/v1/measurements';
/** Desde dónde se mide. Sin cuenta, Globalping permite unas 250 sondas por hora. */
const LOCATIONS = ['Spain', 'Germany', 'United States', 'Mexico', 'Colombia', 'Argentina'];
/** Una medición por servidor dura este tiempo: así varios clics seguidos no gastan el cupo de la API. */
const CACHE_MS = 5 * 60_000;
const POLL_MS = 1000;
const MAX_WAIT_MS = 25_000;

export interface ProbeLatency {
    country: string;
    city: string;
    /** Media en ms, o null si la sonda no obtuvo respuesta. */
    avgMs: number | null;
}

export interface LatencyReport {
    target: string;
    measuredAt: number;
    results: ProbeLatency[];
}

interface GlobalpingResult {
    probe: { country: string; city: string };
    result: { status: string; stats?: { avg: number | null; rcv: number } };
}

/** Separa "host[:puerto]" (también "[ipv6]:puerto"). */
export function splitAddress(address: string): { host: string; port: number | null } {
    const a = address.trim();
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
    if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null };
    const m = /^([^:]+):(\d+)$/.exec(a);
    if (m) return { host: m[1], port: Number(m[2]) };
    return { host: a, port: null };
}

async function measure(type: ServerKind, host: string, port: number): Promise<ProbeLatency[]> {
    // Minecraft va por TCP: se mide el tiempo de conexión al puerto del juego. Hytale usa UDP (QUIC), así que ping ICMP.
    const measurementOptions = type === 'minecraft' ? { protocol: 'TCP', port, packets: 3 } : { packets: 3 };
    const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'ping', target: host, locations: LOCATIONS.map(magic => ({ magic, limit: 1 })), measurementOptions }),
        signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) throw new Error('Se ha alcanzado el límite de mediciones por hora. Prueba más tarde.');
    if (!res.ok) throw new Error(`El servicio de medición respondió HTTP ${res.status}`);
    const { id } = await res.json() as { id: string };

    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const r = await fetch(`${API}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`El servicio de medición respondió HTTP ${r.status}`);
        const d = await r.json() as { status: string; results: GlobalpingResult[] };
        if (d.status !== 'in-progress' || Date.now() > deadline) {
            return d.results.map(x => ({
                country: x.probe.country,
                city: x.probe.city,
                avgMs: x.result.status === 'finished' && x.result.stats?.rcv && x.result.stats.avg !== null ? x.result.stats.avg ?? null : null,
            }));
        }
    }
}

export class LatencyChecker {
    private cache = new Map<string, { at: number; report: Promise<LatencyReport> }>();

    /** Mide (o devuelve la medición reciente) la latencia hasta host:port desde varios países. */
    check(type: ServerKind, host: string, port: number): Promise<LatencyReport> {
        const key = `${type}|${host}|${port}`;
        const hit = this.cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_MS) return hit.report;
        const report = measure(type, host, port).then(results => ({ target: `${host}:${port}`, measuredAt: Date.now(), results }));
        this.cache.set(key, { at: Date.now(), report });
        report.catch(() => this.cache.delete(key)); // un fallo no se guarda
        return report;
    }
}

export function countryFlag(code: string): string {
    if (!/^[A-Za-z]{2}$/.test(code)) return '🏳️';
    return String.fromCodePoint(...code.toUpperCase().split('').map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function latencyDot(ms: number | null): string {
    if (ms === null) return '⚫';
    if (ms < 60) return '🟢';
    if (ms < 120) return '🟡';
    if (ms < 200) return '🟠';
    return '🔴';
}
