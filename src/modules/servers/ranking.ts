import { EmbedBuilder, escapeMarkdown } from 'discord.js';

/**
 * Estadísticas que envía el mod kb_discord_auth y cómo se muestran.
 * Contrato: kb_discord_auth/docs/stats-contract.md (versión 1).
 */
export const STAT_KEYS = ['playTimeSeconds', 'deaths', 'mobKills', 'distanceCm', 'advancements'] as const;
export type StatKey = typeof STAT_KEYS[number];
export type Stats = Partial<Record<StatKey, number>>;

export type Period = 'total' | 'weekly';
export const PERIODS: readonly Period[] = ['total', 'weekly'];

export const STAT_INFO: Record<StatKey, { label: string; emoji: string }> = {
    playTimeSeconds: { label: 'Tiempo jugado', emoji: '⏱️' },
    deaths: { label: 'Más muertes', emoji: '💀' },
    mobKills: { label: 'Mobs matados', emoji: '⚔️' },
    distanceCm: { label: 'Distancia recorrida', emoji: '🧭' },
    advancements: { label: 'Logros', emoji: '🏅' },
};

export const PERIOD_LABEL: Record<Period, string> = { total: 'Total', weekly: 'Esta semana' };

/** 1234567 → "1.234.567" (también con 4 cifras, que es-ES no agrupa). */
export const thousands = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Segundos → "3d 4h", "5h 12m" o "42m". */
export function fmtPlayTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
}

/** Centímetros → "12.3 km" o "850 m". */
export function fmtDistance(cm: number): string {
    if (cm >= 100_000) return `${(Math.floor(cm / 10_000) / 10).toFixed(1)} km`;
    return `${Math.floor(cm / 100)} m`;
}

export function fmtStat(key: StatKey, v: number): string {
    if (key === 'playTimeSeconds') return fmtPlayTime(v);
    if (key === 'distanceCm') return fmtDistance(v);
    return thousands(v);
}

export interface RankRow {
    uuid: string;
    name: string;
    discordId: string | null;
    takenAt: number;
    value: number;
}

/** De más a menos; empate: quien llegó antes a ese valor (taken_at menor) y luego por nombre. */
export function sortRows(rows: RankRow[]): RankRow[] {
    return rows.sort((a, b) => b.value - a.value || a.takenAt - b.takenAt || a.name.localeCompare(b.name));
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** Una línea del ranking: posición, jugador (mención si sigue en el Discord) y valor. */
export function rankLine(pos: number, row: RankRow, key: StatKey, inGuild: (id: string) => boolean): string {
    const name = escapeMarkdown(row.name);
    const who = row.discordId && inGuild(row.discordId) ? `<@${row.discordId}> (${name})` : `**${name}**`;
    return `${MEDALS[pos - 1] ?? `\`${pos}.\``} ${who} · ${fmtStat(key, row.value)}`;
}

/** Une líneas sin pasarse del límite de un campo (1024). */
function fit(lines: string[], limit = 1024): string {
    let out = '';
    for (const l of lines) {
        if (out.length + l.length + 1 > limit) break;
        out += (out ? '\n' : '') + l;
    }
    return out || '*Sin datos todavía*';
}

export interface RenderInput {
    title: string;
    stats: StatKey[];
    periods: Period[];
    top: number;
    /** Filas por estadística y periodo, ya filtradas y ordenadas. */
    rows: (key: StatKey, period: Period) => RankRow[];
    inGuild: (id: string) => boolean;
    updatedAt: number;
    stale: boolean;
}

const embedSize = (e: EmbedBuilder) => {
    const d = e.data;
    return (d.title?.length ?? 0) + (d.description?.length ?? 0) + (d.footer?.text.length ?? 0)
        + (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
};

/** Mensaje del ranking: cabecera en el contenido y un embed por estadística (≤ 6000 caracteres en total). */
export function renderRanking(input: RenderInput): { content: string; embeds: EmbedBuilder[] } {
    const content = [
        `## ${input.title}`.slice(0, 300),
        `-# Actualizado <t:${Math.floor(input.updatedAt / 1000)}:R>${input.stale ? ' · ⚠ sin datos recientes del servidor' : ''}`,
    ].join('\n');

    const build = (top: number) => input.stats.map(key => {
        const info = STAT_INFO[key];
        const embed = new EmbedBuilder().setColor(0xf1c40f).setTitle(`${info.emoji} ${info.label}`);
        const lists = input.periods.map(p => fit(input.rows(key, p).slice(0, top).map((r, i) => rankLine(i + 1, r, key, input.inGuild))));
        if (input.periods.length === 1) embed.setDescription(lists[0]);
        else embed.addFields(input.periods.map((p, i) => ({ name: PERIOD_LABEL[p], value: lists[i], inline: true })));
        return embed;
    });

    // Discord admite 6000 caracteres entre todos los embeds: si no cabe, se recorta el top.
    for (let top = input.top; top > 1; top--) {
        const embeds = build(top);
        if (embeds.reduce((n, e) => n + embedSize(e), 0) <= 5800) return { content, embeds };
    }
    return { content, embeds: build(1) };
}
