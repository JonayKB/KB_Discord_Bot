import { useCallback, useEffect, useMemo, useState } from 'react';
import { del, get, post, put, type Channel, type GameServer, type McLeaderboard, type McPeriod, type McPlayerStats, type McStatKey, type McStatsOverview } from '../api';
import { fmtDateTime, fmtRelative } from '../format';
import { useLive } from '../live';
import { ChannelSelect, Check, Empty, Icon, Modal, Spinner, Switch, errMsg, toast, useConfirm, useMemberLabel } from '../ui';

const STATS: Array<[McStatKey, string]> = [
    ['playTimeSeconds', 'Tiempo jugado'],
    ['deaths', 'Muertes'],
    ['mobKills', 'Mobs matados'],
    ['distanceCm', 'Distancia'],
    ['advancements', 'Logros'],
];
const STAT_LABEL = Object.fromEntries(STATS) as Record<McStatKey, string>;
const PERIOD_LABEL: Record<McPeriod, string> = { total: 'Total', weekly: 'Esta semana' };

function fmtStat(key: McStatKey, v: number | undefined): string {
    if (v === undefined) return '—';
    if (key === 'playTimeSeconds') {
        const m = Math.floor(v / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
    }
    if (key === 'distanceCm') return v >= 100_000 ? `${(Math.floor(v / 10_000) / 10).toFixed(1)} km` : `${Math.floor(v / 100)} m`;
    return v.toLocaleString('es-ES', { useGrouping: 'always' } as Intl.NumberFormatOptions);
}

/** Estadísticas de jugadores que envía el mod kb_discord_auth y rankings en Discord. */
export default function ServerRanking({ server, running, channels }: { server: GameServer; running: boolean; channels: Channel[] }) {
    const [data, setData] = useState<McStatsOverview | null>(null);
    const load = useCallback(() => {
        get<McStatsOverview>(`/servers/${server.id}/stats`).then(setData).catch(e => toast.error(errMsg(e)));
    }, [server.id]);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'mcstats:changed' && e.data?.serverId === server.id) load(); });

    if (!data) return <Spinner />;
    return (
        <div className="stack">
            <KeySection server={server} data={data} running={running} onChange={load} />
            <Leaderboards server={server} data={data} running={running} channels={channels} onChange={load} />
            <Players server={server} data={data} running={running} />
        </div>
    );
}

// ───────────────────────────── API key ─────────────────────────────

function KeySection({ server, data, running, onChange }: { server: GameServer; data: McStatsOverview; running: boolean; onChange: () => void }) {
    const confirm = useConfirm();
    const [newKey, setNewKey] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const generate = async () => {
        if (data.key.configured && !(await confirm({
            title: 'Regenerar la API key',
            message: 'La key actual deja de valer al momento: el mod no podrá enviar estadísticas hasta que pongas la nueva en su configuración.',
            confirmLabel: 'Regenerar', danger: true,
        }))) return;
        setBusy(true);
        try { const r = await post<{ key: string }>(`/servers/${server.id}/stats/key`); setNewKey(r.key); onChange(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setBusy(false); }
    };
    const revoke = async () => {
        if (!(await confirm({ title: 'Revocar la API key', message: 'El mod dejará de poder enviar estadísticas. Los datos guardados se conservan.', confirmLabel: 'Revocar', danger: true }))) return;
        try { await del(`/servers/${server.id}/stats/key`); toast.ok('Key revocada'); onChange(); } catch (e) { toast.error(errMsg(e)); }
    };

    const toml = (key: string) => `[stats]\n\tenabled = true\n\tendpoint = "${data.endpoint}"\n\tapiKey = "${key}"\n\tintervalMinutes = 5\n\tbackfillOnStart = true`;
    const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.ok('Copiado'), () => toast.error('No se pudo copiar'));

    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="row between wrap">
                <b>Mod kb_discord_auth</b>
                {data.key.configured ? <span className="badge ok">Key configurada</span> : <span className="badge">Sin key</span>}
            </div>
            <div className="row wrap" style={{ gap: 16 }}>
                <span className="small" style={{ wordBreak: 'break-all' }}>Endpoint: <code>{data.endpoint}</code></span>
                {data.key.createdAt && <span className="muted small" title={fmtDateTime(data.key.createdAt)}>Key creada {fmtRelative(data.key.createdAt)}</span>}
            </div>
            <div className="row wrap">
                <button className="btn sm" disabled={!running || busy} onClick={generate}><Icon name="refresh" size={14} /> {data.key.configured ? 'Regenerar key' : 'Generar key'}</button>
                {data.key.configured && <button className="btn sm ghost" disabled={!running} onClick={revoke}>Revocar</button>}
            </div>
            {data.lastPushAt
                ? <div className={`small ${data.stale ? '' : 'muted'}`} title={fmtDateTime(data.lastPushAt)}>
                    Último envío {fmtRelative(data.lastPushAt)}{data.displayName && <> · <b>{data.displayName}</b></>} · {data.players.length} jugadores
                    {data.stale && <> · ⚠ sin datos recientes (normal si no hay nadie conectado)</>}
                </div>
                : data.key.configured && <div className="hint">Aún no ha llegado ningún envío. Pon la key en <code>config/kb_discord_auth-common.toml</code> y reinicia el servidor.</div>}
            {!data.endpoint.startsWith('https://') && <div className="hint">El panel no usa HTTPS: la key viajaría sin cifrar si el servidor de Minecraft está en otra máquina.</div>}

            {newKey && (
                <Modal title="Nueva API key" onClose={() => setNewKey(null)} footer={<button className="btn primary" onClick={() => setNewKey(null)}>Hecho</button>}>
                    <div className="stack">
                        <div className="alert">Solo se muestra esta vez. Si la pierdes, genera otra.</div>
                        <div className="row">
                            <input type="text" className="grow mono" readOnly value={newKey} onFocus={e => e.target.select()} />
                            <button className="btn" onClick={() => copy(newKey)}>Copiar</button>
                        </div>
                        <div className="row between"><b>config/kb_discord_auth-common.toml</b><button className="btn sm ghost" onClick={() => copy(toml(newKey))}>Copiar</button></div>
                        <pre className="console" style={{ whiteSpace: 'pre-wrap' }}>{toml(newKey)}</pre>
                    </div>
                </Modal>
            )}
        </div>
    );
}

// ───────────────────────────── Rankings en Discord ─────────────────────────────

function Leaderboards({ server, data, running, channels, onChange }: { server: GameServer; data: McStatsOverview; running: boolean; channels: Channel[]; onChange: () => void }) {
    const confirm = useConfirm();
    const [editing, setEditing] = useState<McLeaderboard | 'new' | null>(null);
    const [publishing, setPublishing] = useState<number | null>(null);
    const channelName = (id: string) => channels.find(c => c.id === id)?.name ?? id;

    const publishNow = async (lb: McLeaderboard) => {
        setPublishing(lb.id);
        try {
            const r = await post<McLeaderboard>(`/servers/${server.id}/leaderboards/${lb.id}/publish`);
            if (r.lastError) toast.error(r.lastError); else toast.ok('Ranking publicado');
            onChange();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setPublishing(null); }
    };
    const remove = async (lb: McLeaderboard) => {
        if (!(await confirm({ title: 'Eliminar ranking', message: `Deja de actualizarse el ranking de #${channelName(lb.channelId)}. El mensaje se queda en Discord; puedes borrarlo a mano.`, confirmLabel: 'Eliminar', danger: true }))) return;
        try { await del(`/servers/${server.id}/leaderboards/${lb.id}`); onChange(); } catch (e) { toast.error(errMsg(e)); }
    };
    const toggle = async (lb: McLeaderboard, enabled: boolean) => {
        try { await put(`/servers/${server.id}/leaderboards/${lb.id}`, { ...lb, enabled }); onChange(); } catch (e) { toast.error(errMsg(e)); }
    };

    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="row between wrap">
                <b>Rankings en Discord</b>
                <button className="btn sm" disabled={!running} onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Nuevo ranking</button>
            </div>
            {data.leaderboards.length === 0 && <div className="muted small">Un mensaje en un canal con el top de jugadores, que el bot va editando.</div>}
            {data.leaderboards.map(lb => (
                <div key={lb.id} className="tile stack" style={{ gap: 6 }}>
                    <div className="row between wrap">
                        <div className="row wrap" style={{ minWidth: 0 }}>
                            <b className="ellipsis">#{channelName(lb.channelId)}</b>
                            <span className="muted small">{lb.periods.map(p => PERIOD_LABEL[p]).join(' + ')} · top {lb.top} · cada {lb.intervalMin} min</span>
                        </div>
                        <div className="row">
                            <Switch checked={lb.enabled} disabled={!running} onChange={v => toggle(lb, v)} label="Actualizar este ranking" />
                            <button className="btn sm" disabled={!running || publishing === lb.id} onClick={() => publishNow(lb)}>{publishing === lb.id ? 'Publicando…' : 'Publicar ahora'}</button>
                            <button className="btn sm" disabled={!running} onClick={() => setEditing(lb)}><Icon name="edit" size={14} /></button>
                            <button className="btn sm danger" disabled={!running} onClick={() => remove(lb)} aria-label="Eliminar ranking"><Icon name="trash" size={14} /></button>
                        </div>
                    </div>
                    <div className="muted small">{lb.stats.map(s => STAT_LABEL[s]).join(', ')}{lb.linkedOnly && ' · solo vinculados'}{lb.exclude.length > 0 && ` · ${lb.exclude.length} excluidos`}</div>
                    {lb.lastPostedAt && !lb.lastError && <div className="muted small" title={fmtDateTime(lb.lastPostedAt)}>Actualizado {fmtRelative(lb.lastPostedAt)}</div>}
                    {lb.lastError && <div className="alert danger">No se pudo publicar: {lb.lastError}</div>}
                </div>
            ))}
            {editing && <LeaderboardEditor server={server} initial={editing === 'new' ? null : editing} channels={channels} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} />}
        </div>
    );
}

function LeaderboardEditor({ server, initial, channels, onClose, onSaved }: {
    server: GameServer; initial: McLeaderboard | null; channels: Channel[]; onClose: () => void; onSaved: () => void;
}) {
    const [f, setF] = useState(() => ({
        enabled: initial?.enabled ?? true,
        channelId: initial?.channelId ?? '',
        stats: initial?.stats ?? STATS.map(s => s[0]),
        periods: initial?.periods ?? (['total', 'weekly'] as McPeriod[]),
        top: initial?.top ?? 10,
        intervalMin: initial?.intervalMin ?? 15,
        title: initial?.title ?? '🏆 {server}',
        linkedOnly: initial?.linkedOnly ?? false,
        exclude: (initial?.exclude ?? []).join('\n'),
    }));
    const [saving, setSaving] = useState(false);
    const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
    const toggleIn = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter(x => x !== v));

    const save = async () => {
        if (!f.channelId) return toast.error('Elige un canal.');
        if (!f.stats.length) return toast.error('Elige al menos una estadística.');
        if (!f.periods.length) return toast.error('Elige al menos un periodo.');
        setSaving(true);
        const body = { ...f, exclude: f.exclude.split(/[\n,]/).map(s => s.trim()).filter(Boolean) };
        try {
            const lb = initial
                ? await put<McLeaderboard>(`/servers/${server.id}/leaderboards/${initial.id}`, body)
                : await post<McLeaderboard>(`/servers/${server.id}/leaderboards`, body);
            // Se publica al momento para ver el resultado.
            const r = await post<McLeaderboard>(`/servers/${server.id}/leaderboards/${lb.id}/publish`);
            if (r.lastError) toast.error(`Guardado, pero no se pudo publicar: ${r.lastError}`); else toast.ok('Ranking publicado');
            onSaved();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal title={initial ? 'Editar ranking' : 'Nuevo ranking'} onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar y publicar'}</button>
        </>}>
            <div className="stack">
                <label className="field">Canal<ChannelSelect value={f.channelId} channels={channels} onChange={v => set('channelId', v)} /></label>
                {initial && f.channelId !== initial.channelId && <div className="hint">Al cambiar de canal se publica un mensaje nuevo; el anterior se queda donde está.</div>}
                <label className="field">Título<input type="text" maxLength={200} value={f.title} onChange={e => set('title', e.target.value)} /></label>
                <span className="hint"><code>{'{server}'}</code> se cambia por el nombre del servidor (<code>serverName</code> del mod).</span>
                <div className="field stack" style={{ gap: 5 }}><span style={{ fontWeight: 600, fontSize: 13 }}>Estadísticas</span>
                    <div className="row wrap">{STATS.map(([k, l]) => <Check key={k} label={l} checked={f.stats.includes(k)} onChange={v => set('stats', STATS.map(s => s[0]).filter(x => toggleIn(f.stats, k, v).includes(x)))} />)}</div>
                </div>
                <div className="field stack" style={{ gap: 5 }}><span style={{ fontWeight: 600, fontSize: 13 }}>Periodo</span>
                    <div className="row wrap">{(['total', 'weekly'] as McPeriod[]).map(p => <Check key={p} label={PERIOD_LABEL[p]} checked={f.periods.includes(p)} onChange={v => set('periods', (['total', 'weekly'] as McPeriod[]).filter(x => toggleIn(f.periods, p, v).includes(x)))} />)}</div>
                </div>
                <span className="hint">La semana empieza el lunes a las 00:00.</span>
                <div className="row wrap">
                    <label className="field" style={{ width: 140 }}>Top<input type="number" min={1} max={25} value={f.top} onChange={e => set('top', Number(e.target.value))} /></label>
                    <label className="field" style={{ width: 200 }}>Actualizar cada (min)<input type="number" min={5} max={1440} value={f.intervalMin} onChange={e => set('intervalMin', Number(e.target.value))} /></label>
                </div>
                <Check label="Solo jugadores vinculados" hint="Oculta a quien no tiene una cuenta de Discord vinculada en el mod." checked={f.linkedOnly} onChange={v => set('linkedOnly', v)} />
                <label className="field">Excluir
                    <textarea rows={3} value={f.exclude} placeholder={'Un UUID o nombre por línea (staff, cuentas de prueba…)'} onChange={e => set('exclude', e.target.value)} />
                </label>
            </div>
        </Modal>
    );
}

// ───────────────────────────── Jugadores ─────────────────────────────

function DiscordCell({ id }: { id: string | null }) {
    const label = useMemberLabel(id ?? '');
    if (!id) return <span className="muted">—</span>;
    return <span title={id}>{label}</span>;
}

const PAGE = 50;

function Players({ server, data, running }: { server: GameServer; data: McStatsOverview; running: boolean }) {
    const confirm = useConfirm();
    const [period, setPeriod] = useState<McPeriod>('total');
    const [sort, setSort] = useState<McStatKey>('playTimeSeconds');
    const [q, setQ] = useState('');
    const [limit, setLimit] = useState(PAGE);

    const rows = useMemo(() => {
        const needle = q.trim().toLowerCase();
        return data.players
            .filter(p => !needle || p.name.toLowerCase().includes(needle) || p.uuid.startsWith(needle) || p.discordId === needle)
            .sort((a, b) => (b[period][sort] ?? -1) - (a[period][sort] ?? -1) || a.takenAt - b.takenAt || a.name.localeCompare(b.name));
    }, [data.players, period, sort, q]);

    const remove = async (p: McPlayerStats) => {
        if (!(await confirm({ title: 'Borrar estadísticas', message: <>Se borran los datos guardados de <b>{p.name}</b>. Volverán a aparecer con el próximo envío del mod si sigue jugando; para ocultarlo siempre, añádelo a "Excluir" en el ranking.</>, confirmLabel: 'Borrar', danger: true }))) return;
        try { await del(`/servers/${server.id}/stats/players/${p.uuid}`); } catch (e) { toast.error(errMsg(e)); }
    };

    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="row between wrap">
                <b>Jugadores ({data.players.length})</b>
                <div className="row wrap">
                    <input type="search" placeholder="Buscar…" value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE); }} style={{ width: 180 }} />
                    <div className="seg" role="group" aria-label="Periodo">
                        {(['total', 'weekly'] as McPeriod[]).map(p => <button key={p} type="button" className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>)}
                    </div>
                </div>
            </div>
            {period === 'weekly' && <div className="hint">Desde el lunes a las 00:00 ({data.timezone}). Quien aparece por primera vez a mitad de semana empieza en 0.</div>}
            {data.players.length === 0 ? <Empty title="Sin estadísticas todavía" /> : (
                <div className="table-wrap" style={{ maxHeight: 480, overflowY: 'auto' }}>
                    <table>
                        <thead><tr>
                            <th>#</th><th>Jugador</th><th>Discord</th>
                            {STATS.map(([k, l]) => (
                                <th key={k} aria-sort={sort === k ? 'descending' : undefined}>
                                    <button type="button" title="Ordenar por esta columna" onClick={() => setSort(k)}
                                        style={{ all: 'unset', cursor: 'pointer', font: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit', color: sort === k ? 'var(--text)' : 'inherit' }}>{l}{sort === k ? ' ↓' : ''}</button>
                                </th>
                            ))}
                            <th>Actualizado</th><th />
                        </tr></thead>
                        <tbody>
                            {rows.slice(0, limit).map((p, i) => (
                                <tr key={p.uuid}>
                                    <td className="muted small">{i + 1}</td>
                                    <td><span title={p.uuid}>{p.name}</span></td>
                                    <td className="small"><DiscordCell id={p.discordId} /></td>
                                    {STATS.map(([k]) => <td key={k} className="nowrap">{fmtStat(k, p[period][k])}</td>)}
                                    <td className="muted small nowrap" title={fmtDateTime(p.takenAt)}>{fmtRelative(p.takenAt)}</td>
                                    <td><button className="btn sm ghost" disabled={!running} onClick={() => remove(p)} aria-label={`Borrar estadísticas de ${p.name}`}><Icon name="trash" size={14} /></button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {rows.length > limit && <button className="btn sm ghost" onClick={() => setLimit(l => l + PAGE)}>Ver más ({rows.length - limit})</button>}
        </div>
    );
}
