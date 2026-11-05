import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';

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
function fit(lines: string[], limit: number): string {
    let out = '';
    for (const l of lines) {
        if (out.length + l.length + 1 > limit) break;
        out += (out ? '\n' : '') + l;
    }
    return out || '*Sin datos todavía*';
}

export interface RenderInput {
    /** Prefijo del custom_id de los controles (ver controlPrefix). */
    controls: string;
    title: string;
    /** Categorías y periodos que se pueden elegir (configuración del ranking). */
    stats: StatKey[];
    periods: Period[];
    top: number;
    /** Vista que se muestra. */
    stat: StatKey;
    period: Period;
    /** Filas de esa vista, ya filtradas y ordenadas. */
    rows: RankRow[];
    inGuild: (id: string) => boolean;
    updatedAt: number;
    stale: boolean;
    /** En la vista privada: quién la ve, para mostrar su posición. */
    viewerId?: string;
}

/**
 * custom_id de los controles: "<origen>:<id>:s:<periodo>" (menú) y "<origen>:<id>:p:<estadística>:<periodo>" (botones).
 * Origen "mclb": un ranking publicado en un canal (id del ranking). "mcrk": el comando /ranking (id del servidor).
 */
export type ControlSource = 'mclb' | 'mcrk';
export const controlPrefix = (source: ControlSource, id: number) => `${source}:${id}`;

export function parseControl(customId: string, values: readonly string[] = []): { source: ControlSource; id: number; stat: StatKey; period: Period } | null {
    const [source, rawId, kind, a, b] = customId.split(':');
    if (source !== 'mclb' && source !== 'mcrk') return null;
    const id = Number(rawId);
    const stat = (kind === 's' ? values[0] : a) as StatKey;
    const period = (kind === 's' ? a : b) as Period;
    if (!Number.isSafeInteger(id) || !STAT_KEYS.includes(stat) || !PERIODS.includes(period)) return null;
    return { source, id, stat, period };
}

export type RankingMessage = {
    content: string;
    embeds: EmbedBuilder[];
    components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>>;
};

/** Un solo embed con la vista elegida, un menú para la categoría y botones para el periodo. */
export function renderRanking(input: RenderInput): RankingMessage {
    const info = STAT_INFO[input.stat];
    const lines = input.rows.slice(0, input.top).map((r, i) => rankLine(i + 1, r, input.stat, input.inGuild));
    const parts = [`### ${info.emoji} ${info.label} · ${PERIOD_LABEL[input.period]}`, fit(lines, 3600)];
    if (input.viewerId) {
        const mine = input.rows.findIndex(r => r.discordId === input.viewerId);
        parts.push(mine >= 0
            ? `Tu posición: **#${mine + 1}** de ${input.rows.length} · ${fmtStat(input.stat, input.rows[mine].value)}`
            : '*No apareces en esta categoría.*');
    }
    parts.push(`-# Actualizado <t:${Math.floor(input.updatedAt / 1000)}:R>${input.stale ? ' · ⚠ sin datos recientes del servidor' : ''}`);

    const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(input.title.slice(0, 256))
        .setDescription(parts.join('\n\n'));

    const components: RankingMessage['components'] = [];
    if (input.stats.length > 1) {
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${input.controls}:s:${input.period}`)
                .setPlaceholder('Elige una categoría')
                .addOptions(input.stats.map(k => ({ label: STAT_INFO[k].label, value: k, emoji: STAT_INFO[k].emoji, default: k === input.stat }))),
        ));
    }
    if (input.periods.length > 1) {
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(input.periods.map(p =>
            new ButtonBuilder()
                .setCustomId(`${input.controls}:p:${input.stat}:${p}`)
                .setLabel(PERIOD_LABEL[p])
                .setStyle(p === input.period ? ButtonStyle.Primary : ButtonStyle.Secondary),
        )));
    }
    return { content: '', embeds: [embed], components };
}
