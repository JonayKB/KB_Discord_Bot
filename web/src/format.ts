export const fmtDateTime = (ts: number, tz?: string | null) =>
    new Date(ts).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', ...(tz ? { timeZone: tz } : {}) });

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

export function fmtRelative(ts: number, now = Date.now()): string {
    const diff = ts - now;
    const abs = Math.abs(diff);
    const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
    if (abs < 45_000) return diff < 0 ? 'hace un momento' : 'en unos segundos';
    if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
    if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
    return rtf.format(Math.round(diff / 86400_000), 'day');
}

export function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    return `${m} min`;
}

export function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const SOURCE_LABEL: Record<string, string> = {
    manual: 'Manual',
    reply: 'Respuesta',
    schedule: 'Programado',
    campaign: 'Confirmación',
    welcome: 'Bienvenida',
    system: 'Sistema',
    dm: 'MD recibido',
};

// ───────────── Zonas horarias (para el editor de programaciones) ─────────────

function tzOffsetMs(ts: number, tz: string): number {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(ts).map(p => [p.type, p.value])
    );
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ts;
}

/** Convierte "fecha y hora en la zona tz" a milisegundos UTC. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ts = guess - tzOffsetMs(guess, tz);
    ts = guess - tzOffsetMs(ts, tz); // segunda pasada por los cambios de hora
    return ts;
}

/** Devuelve { y, mo, d, h, mi } de un instante visto desde la zona tz. */
export function utcToZoned(ts: number, tz: string) {
    const o = tzOffsetMs(ts, tz);
    const d = new Date(ts + o);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

export const pad = (n: number) => String(n).padStart(2, '0');

export const DEFAULT_TZ = 'Europe/Madrid';

export function validTz(tz: string): boolean {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
