import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Gráficas de series temporales en SVG, sin librerías.
 * Una métrica por gráfica (nunca dos ejes Y); varias gráficas pueden compartir el cursor
 * pasando el mismo `hover`/`onHover`, así el tooltip marca el mismo instante en todas.
 */

export interface TimePoint { t: number; v: number | null }

const H = 150;
const PAD = { top: 10, right: 12, bottom: 24, left: 40 };

/** Siguiente valor "redondo" (1, 2, 2.5, 5 × 10^n) para el techo del eje Y. */
export function niceMax(v: number): number {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
}

function useWidth<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [w, setW] = useState(600);
    useEffect(() => {
        if (!ref.current) return;
        const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
        ro.observe(ref.current);
        return () => ro.disconnect();
    }, []);
    return [ref, w] as const;
}

const fmtAxisTime = (t: number, span: number) => new Date(t).toLocaleString('es-ES',
    span <= 86_400_000 ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' });
export const fmtTipTime = (t: number) => new Date(t).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Índice del punto más cercano a un instante. */
function nearest(points: TimePoint[], t: number): number {
    let best = -1;
    let bestD = Infinity;
    points.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bestD) { bestD = d; best = i; } });
    return best;
}

export function TimeChart({ title, points, from, to, gapMs, unit = '', yMax, decimals = 0, reference, hover, onHover, empty }: {
    title: string;
    points: TimePoint[];
    from: number;
    to: number;
    /** Si dos puntos seguidos están más separados que esto, la línea se corta (no hay datos). */
    gapMs: number;
    unit?: string;
    /** Techo fijo del eje Y (p. ej. 20 para TPS). Si no, se calcula. */
    yMax?: number;
    decimals?: number;
    /** Línea de referencia discontinua (p. ej. máximo de jugadores). */
    reference?: { value: number; label: string };
    hover: number | null;
    onHover: (t: number | null) => void;
    empty?: string;
}) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const innerW = width - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const values = points.map(p => p.v).filter((v): v is number => v !== null);
    const top = yMax ?? niceMax(Math.max(...values, reference?.value ?? 0, 0) * 1.1);
    const x = (t: number) => PAD.left + ((t - from) / Math.max(to - from, 1)) * innerW;
    const y = (v: number) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;
    const fmt = (v: number) => `${v.toLocaleString('es-ES', { maximumFractionDigits: decimals })}${unit}`;

    // Tramos continuos (se cortan donde falta el dato o hay un hueco de tiempo).
    const runs: TimePoint[][] = [];
    let cur: TimePoint[] = [];
    points.forEach((p, i) => {
        const prev = points[i - 1];
        if (p.v === null || (prev && p.t - prev.t > gapMs)) { if (cur.length) runs.push(cur); cur = []; }
        if (p.v !== null) cur.push(p);
    });
    if (cur.length) runs.push(cur);

    const line = (r: TimePoint[]) => r.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join('');
    const area = (r: TimePoint[]) => `${line(r)}L${x(r[r.length - 1].t).toFixed(1)},${y(0)}L${x(r[0].t).toFixed(1)},${y(0)}Z`;

    const ticksY = [0, top / 2, top];
    const nTicksX = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
    const ticksX = Array.from({ length: nTicksX }, (_, i) => from + ((to - from) * i) / (nTicksX - 1));

    const idx = hover !== null ? nearest(points, hover) : -1;
    const hp = idx >= 0 ? points[idx] : null;
    const last = [...points].reverse().find(p => p.v !== null);

    const move = (e: PointerEvent<SVGRectElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        const t = from + ((e.clientX - box.left) / box.width) * (to - from);
        const i = nearest(points, t);
        onHover(i >= 0 ? points[i].t : null);
    };
    const key = (e: KeyboardEvent<SVGSVGElement>) => {
        if (!points.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const i = idx < 0 ? points.length - 1 : Math.min(points.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)));
        onHover(points[i].t);
    };

    return (
        <div className="chart" ref={ref}>
            <div className="chart-head">
                <b>{title}</b>
                {last && <span className="muted small">Ahora <b className="chart-now">{fmt(last.v!)}</b></span>}
            </div>
            {!values.length ? <div className="chart-empty muted small">{empty ?? 'Sin datos en este rango.'}</div> : (
                <svg width={width} height={H} role="img" aria-label={`${title}: gráfica de los valores en el tiempo`} tabIndex={0} onKeyDown={key} onBlur={() => onHover(null)}>
                    {ticksY.map(v => (
                        <g key={v}>
                            <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
                            <text className="chart-tick" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">{fmt(v)}</text>
                        </g>
                    ))}
                    {ticksX.map((t, i) => (
                        <text key={t} className="chart-tick" x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'}>{fmtAxisTime(t, to - from)}</text>
                    ))}
                    {reference && reference.value <= top && (
                        <g>
                            <line className="chart-ref" x1={PAD.left} x2={width - PAD.right} y1={y(reference.value)} y2={y(reference.value)} />
                            <text className="chart-tick" x={width - PAD.right} y={y(reference.value) - 4} textAnchor="end">{reference.label}</text>
                        </g>
                    )}
                    {runs.map((r, i) => <path key={`a${i}`} className="chart-area" d={area(r)} />)}
                    {runs.map((r, i) => <path key={`l${i}`} className="chart-line" d={line(r)} />)}
                    {runs.filter(r => r.length === 1).map(r => <circle key={`d${r[0].t}`} className="chart-dot" cx={x(r[0].t)} cy={y(r[0].v!)} r={3} />)}
                    {hp && (
                        <g pointerEvents="none">
                            <line className="chart-cross" x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={PAD.top + innerH} />
                            {hp.v !== null && <circle className="chart-dot hover" cx={x(hp.t)} cy={y(hp.v)} r={4} />}
                        </g>
                    )}
                    <rect x={PAD.left} y={0} width={innerW} height={H} fill="transparent" onPointerMove={move} onPointerLeave={() => onHover(null)} />
                </svg>
            )}
            {hp && values.length > 0 && (
                <div className="chart-tip" style={{ left: Math.min(Math.max(x(hp.t), 70), width - 70) }}>
                    <b>{hp.v === null ? 'Sin datos' : fmt(hp.v)}</b>
                    <span>{fmtTipTime(hp.t)}</span>
                </div>
            )}
        </div>
    );
}

/** Franja de disponibilidad: verde online, rojo offline, gris sin datos. */
export function UptimeStrip({ points, from, to, bucketMs, hover, onHover }: {
    points: Array<{ t: number; up: number }>;
    from: number;
    to: number;
    bucketMs: number;
    hover: number | null;
    onHover: (t: number | null) => void;
}) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const innerW = width - PAD.left - PAD.right;
    const x = (t: number) => PAD.left + ((t - from) / Math.max(to - from, 1)) * innerW;
    const w = Math.max(1, (bucketMs / Math.max(to - from, 1)) * innerW);
    const hp = hover !== null ? points[nearest(points.map(p => ({ t: p.t, v: p.up })), hover)] : undefined;
    const state = (up: number) => (up >= 0.999 ? 'ok' : up <= 0.001 ? 'down' : 'partial');
    const LABEL = { ok: 'Online', down: 'Offline', partial: 'Caídas intermitentes' } as const;

    return (
        <div className="chart" ref={ref}>
            <div className="chart-head">
                <b>Disponibilidad</b>
                <span className="row small muted" style={{ gap: 12 }}>
                    <span className="row" style={{ gap: 4 }}><i className="uptime-key ok" />Online</span>
                    <span className="row" style={{ gap: 4 }}><i className="uptime-key partial" />Intermitente</span>
                    <span className="row" style={{ gap: 4 }}><i className="uptime-key down" />Offline</span>
                </span>
            </div>
            <svg width={width} height={22} role="img" aria-label="Franja de disponibilidad del servidor">
                <rect className="uptime-bg" x={PAD.left} y={2} width={innerW} height={18} rx={4} />
                {points.map(p => <rect key={p.t} className={`uptime-${state(p.up)}`} x={x(p.t)} y={2} width={w} height={18} />)}
                {hp && <line className="chart-cross" x1={x(hp.t) + w / 2} x2={x(hp.t) + w / 2} y1={0} y2={22} />}
                <rect x={PAD.left} y={0} width={innerW} height={22} fill="transparent"
                    onPointerMove={e => { const b = e.currentTarget.getBoundingClientRect(); onHover(from + ((e.clientX - b.left) / b.width) * (to - from)); }}
                    onPointerLeave={() => onHover(null)} />
            </svg>
            {hp && (
                <div className="chart-tip" style={{ left: Math.min(Math.max(x(hp.t), 70), width - 70), top: 30 }}>
                    <b>{LABEL[state(hp.up)]}{state(hp.up) === 'partial' ? ` (${Math.round(hp.up * 100)}%)` : ''}</b>
                    <span>{fmtTipTime(hp.t)}</span>
                </div>
            )}
        </div>
    );
}
