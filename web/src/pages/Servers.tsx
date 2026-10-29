import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put, type GameServer, type ModuleInfo, type ServerHistory, type ServerKind, type ServerStatus } from '../api';
import { TimeChart, UptimeStrip, fmtTipTime } from '../charts';
import ServerRcon from './ServerRcon';
import { fmtDateTime, fmtRelative } from '../format';
import { useLive } from '../live';
import { Check, ChannelSelect, Empty, Icon, Modal, PageHead, Spinner, Switch, errMsg, toast, useConfirm, useGuildData } from '../ui';

const TYPE_LABEL: Record<ServerKind, string> = { minecraft: 'Minecraft', hytale: 'Hytale' };
const INTERVALS: Array<[number, string]> = [[15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [900, '15 min']];

const tpsColor = (t: number) => (t >= 15 ? 'var(--ok)' : t >= 10 ? 'var(--warn)' : 'var(--danger)');
const address = (s: Pick<GameServer, 'type' | 'host' | 'port' | 'apiPort'>) =>
    s.type === 'minecraft' ? `${s.host}:${s.port ?? 25565}` : `${s.host} · API ${s.apiPort}`;

export default function Servers() {
    const confirm = useConfirm();
    const guild = useGuildData();
    const [servers, setServers] = useState<GameServer[] | null>(null);
    const [intervalSec, setIntervalSec] = useState(30);
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    const [editing, setEditing] = useState<GameServer | 'new' | null>(null);
    const [msgFor, setMsgFor] = useState<GameServer | null>(null);
    const [checking, setChecking] = useState<Set<number>>(new Set());
    const [, tick] = useState(0);

    const load = useCallback(() => {
        get<{ intervalSec: number; servers: GameServer[] }>('/servers')
            .then(r => { setServers(r.servers); setIntervalSec(r.intervalSec); })
            .catch(e => toast.error(errMsg(e)));
        get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'servers') ?? null)).catch(() => undefined);
    }, []);
    useEffect(load, [load]);
    // Refresca los "hace X s" sin pedir nada al servidor.
    useEffect(() => { const t = setInterval(() => tick(x => x + 1), 5000); return () => clearInterval(t); }, []);

    useLive(e => {
        if (e.type === 'servers:status') {
            const st = e.data as ServerStatus;
            setServers(list => list?.map(s => (s.id === st.serverId ? { ...s, status: st } : s)) ?? list);
        } else if (e.type === 'servers:changed') load();
        else if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'servers') ?? null);
    });

    const check = async (s: GameServer) => {
        setChecking(x => new Set(x).add(s.id));
        try {
            const st = await post<ServerStatus>(`/servers/${s.id}/check`);
            setServers(list => list?.map(x => (x.id === s.id ? { ...x, status: st } : x)) ?? list);
        } catch (e) { toast.error(errMsg(e)); }
        finally { setChecking(x => { const n = new Set(x); n.delete(s.id); return n; }); }
    };

    const changeInterval = async (sec: number) => {
        try { const r = await put<{ intervalSec: number }>('/servers/settings', { intervalSec: sec }); setIntervalSec(r.intervalSec); toast.ok('Frecuencia actualizada'); }
        catch (e) { toast.error(errMsg(e)); }
    };

    const toggle = async (s: GameServer, enabled: boolean) => {
        try { await put(`/servers/${s.id}`, { ...s, enabled }); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    const remove = async (s: GameServer) => {
        if (!(await confirm({ title: 'Eliminar servidor', message: <>Se dejará de consultar <b>{s.name}</b>. El mensaje de estado en Discord no se borra, solo deja de actualizarse.</>, confirmLabel: 'Eliminar', danger: true }))) return;
        try { await del(`/servers/${s.id}`); toast.ok('Servidor eliminado'); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    const unlink = async (s: GameServer) => {
        if (!(await confirm({ title: 'Dejar de actualizar el mensaje', message: 'El mensaje se queda en Discord tal cual está; el bot simplemente deja de editarlo. Puedes borrarlo tú a mano.', confirmLabel: 'Dejar de actualizar' }))) return;
        try { await post(`/servers/${s.id}/message/unlink`); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    const channelName = (id: string | null) => guild.channels.find(c => c.id === id)?.name;

    if (!servers) return <div className="page"><Spinner /></div>;
    const running = mod?.running ?? true;

    return (
        <div className="page">
            <PageHead title="Servidores de juego" subtitle="Estado en directo de tus servidores de Minecraft y Hytale, y el mensaje que lo muestra en Discord.">
                <label className="row small muted" title="Cada cuánto se consulta cada servidor">
                    Consultar cada
                    <select style={{ width: 'auto' }} value={intervalSec} disabled={!running} onChange={e => changeInterval(Number(e.target.value))}>
                        {INTERVALS.some(([v]) => v === intervalSec) ? null : <option value={intervalSec}>{intervalSec} s</option>}
                        {INTERVALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </label>
                <button className="btn primary" disabled={!running} onClick={() => setEditing('new')}><Icon name="plus" /> Añadir servidor</button>
            </PageHead>

            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Servidores de juego</b> está desactivado: no se consulta nada y los datos pueden estar desactualizados. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            {servers.length === 0 ? (
                <div className="card"><Empty title="Aún no hay servidores">Añade tu servidor de Minecraft o Hytale para ver jugadores, latencia y rendimiento.</Empty></div>
            ) : (
                <div className="stack">
                    {servers.map(s => (
                        <ServerCard key={s.id} server={s} busy={checking.has(s.id)} running={running} channelName={channelName(s.channelId)}
                            onCheck={() => check(s)} onEdit={() => setEditing(s)} onDelete={() => remove(s)} onToggle={v => toggle(s, v)}
                            onMessage={() => setMsgFor(s)} onUnlink={() => unlink(s)} />
                    ))}
                </div>
            )}

            {editing && <ServerEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
            {msgFor && <MessageModal server={msgFor} channels={guild.channels} onClose={() => setMsgFor(null)} onDone={() => { setMsgFor(null); load(); }} />}
        </div>
    );
}

// ───────────────────────────── Tarjeta de un servidor ─────────────────────────────

function ServerCard({ server: s, busy, running, channelName, onCheck, onEdit, onDelete, onToggle, onMessage, onUnlink }: {
    server: GameServer; busy: boolean; running: boolean; channelName?: string;
    onCheck: () => void; onEdit: () => void; onDelete: () => void; onToggle: (v: boolean) => void; onMessage: () => void; onUnlink: () => void;
}) {
    const st = s.status;
    const [showStats, setShowStats] = useState(false);
    const [showRcon, setShowRcon] = useState(false);
    const state = !s.enabled ? 'paused' : !st ? 'unknown' : st.online ? 'online' : 'offline';
    const fill = st && st.maxPlayers > 0 ? Math.min(st.playersOnline / st.maxPlayers, 1) : 0;

    return (
        <div className="card stack">
            <div className="row between wrap">
                <div className="row" style={{ minWidth: 0 }}>
                    <span className={`dot ${state === 'online' ? 'on' : state === 'offline' ? 'off' : ''}`} aria-hidden />
                    <h2 className="ellipsis">{s.name}</h2>
                    <span className="badge accent">{TYPE_LABEL[s.type]}</span>
                    <span className="mono muted small ellipsis">{address(s)}</span>
                </div>
                <div className="row wrap">
                    <label className="row small muted">Activo <Switch checked={s.enabled} disabled={!running} onChange={onToggle} label="Consultar este servidor" /></label>
                    <button className="btn sm" disabled={!running || !s.enabled || busy} onClick={onCheck}><Icon name="refresh" size={14} /> {busy ? 'Consultando…' : 'Comprobar'}</button>
                    <button className={`btn sm ${showStats ? 'primary' : ''}`} onClick={() => setShowStats(v => !v)} aria-expanded={showStats}><Icon name="chart" size={14} /> Estadísticas</button>
                    {s.type === 'minecraft' && <button className={`btn sm ${showRcon ? 'primary' : ''}`} onClick={() => setShowRcon(v => !v)} aria-expanded={showRcon}><Icon name="terminal" size={14} /> RCON</button>}
                    <button className="btn sm" disabled={!running} onClick={onEdit}><Icon name="edit" size={14} /> Editar</button>
                    <button className="btn sm danger" disabled={!running} onClick={onDelete} aria-label="Eliminar servidor"><Icon name="trash" size={14} /></button>
                </div>
            </div>

            {state === 'paused' && <div className="muted small">Pausado: no se consulta. Actívalo para ver su estado.</div>}
            {state === 'unknown' && <div className="row muted small"><Spinner /> Esperando la primera consulta…</div>}

            {st && s.enabled && (
                <>
                    <div className="grid tiles">
                        <div className="tile">
                            <div className="label">Estado</div>
                            <div className="value" style={{ color: st.online ? 'var(--ok)' : 'var(--danger)' }}>{st.online ? 'Online' : 'Offline'}</div>
                            <div className="muted small">{st.online && st.latencyMs !== null ? `${st.latencyMs} ms de latencia` : ' '}</div>
                        </div>
                        <div className="tile">
                            <div className="label">Jugadores</div>
                            <div className="value">{st.online ? <>{st.playersOnline}<span className="muted" style={{ fontSize: 16, fontWeight: 600 }}> / {st.maxPlayers}</span></> : '—'}</div>
                            <div className="progress" style={{ marginTop: 6 }} aria-hidden><div style={{ width: `${fill * 100}%`, background: fill >= 1 ? 'var(--danger)' : fill > 0.5 ? 'var(--warn)' : 'var(--ok)' }} /></div>
                        </div>
                        {st.tps && (
                            <div className="tile" title={`10 s: ${st.tps.s10.toFixed(2)} · 1 min: ${st.tps.m1.toFixed(2)} · 5 min: ${st.tps.m5.toFixed(2)} · 15 min: ${st.tps.m15.toFixed(2)}`}>
                                <div className="label">TPS (1 min)</div>
                                <div className="value" style={{ color: tpsColor(st.tps.m1) }}>{st.tps.m1.toFixed(1)}</div>
                                <div className="muted small">5 min {st.tps.m5.toFixed(1)} · 15 min {st.tps.m15.toFixed(1)}</div>
                            </div>
                        )}
                        {(st.msptMs !== null || st.cpu !== null) && (
                            <div className="tile">
                                <div className="label">Rendimiento</div>
                                <div className="value">{st.msptMs !== null ? <>{st.msptMs.toFixed(1)}<span className="muted" style={{ fontSize: 14, fontWeight: 600 }}> ms</span></> : '—'}</div>
                                <div className="muted small">{st.cpu !== null ? `CPU ${(st.cpu * 100).toFixed(0)}%` : 'MSPT'}</div>
                            </div>
                        )}
                        {st.online && st.version && (
                            <div className="tile">
                                <div className="label">Versión</div>
                                <div className="value ellipsis" style={{ fontSize: 18, marginTop: 6 }} title={st.version}>{st.version}</div>
                                {st.motd && <div className="muted small ellipsis" title={st.motd}>{st.motd}</div>}
                            </div>
                        )}
                    </div>

                    {!st.online && st.error && <div className="alert danger">{st.error}</div>}
                    {st.warnings.map(w => <div key={w} className="alert">{w}</div>)}
                    {s.type === 'minecraft' && st.online && !s.apiPort && <div className="hint">Para ver TPS, MSPT y CPU indica el puerto de la API de métricas (Spark) al editar el servidor.</div>}

                    {st.online && (
                        <div>
                            <div className="row between small muted" style={{ marginBottom: 6 }}>
                                <b style={{ color: 'var(--text)' }}>Conectados ahora</b>
                                {!st.playerListComplete && <span title='Activa "enable-query=true" en server.properties para ver la lista completa'>Lista parcial</span>}
                            </div>
                            {st.players.length === 0 ? <div className="muted small">No hay jugadores conectados.</div> : (
                                <div className="row wrap" style={{ gap: 6 }}>
                                    {st.players.map(p => (
                                        <span key={p.id ?? p.name} className="chip" style={{ paddingRight: 10 }} title={p.discordName ? `En Discord: ${p.discordName}` : s.linkPlayers ? 'Sin usuario de Discord asociado' : undefined}>
                                            {p.name}{p.discordName && <span className="muted">· {p.discordName}</span>}
                                        </span>
                                    ))}
                                    {st.playersOnline > st.players.length && <span className="muted small">…y {st.playersOnline - st.players.length} más</span>}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="muted small" title={fmtDateTime(st.checkedAt)}>Última consulta {fmtRelative(st.checkedAt)}</div>
                </>
            )}

            {showStats && <><div className="sep" /><ServerStats server={s} /></>}
            {showRcon && s.type === 'minecraft' && <><div className="sep" /><ServerRcon server={s} running={running} /></>}

            <div className="sep" />
            <div className="row between wrap">
                <div>
                    <b>Mensaje de estado en Discord</b>
                    <div className="muted small">
                        {s.messageId
                            ? <>Se actualiza en <b>#{channelName ?? s.channelId}</b> con cada consulta.</>
                            : 'Un mensaje fijo en un canal con el estado, los jugadores y el rendimiento del servidor.'}
                    </div>
                </div>
                <div className="row">
                    {s.messageId && <button className="btn sm ghost" disabled={!running} onClick={onUnlink}>Dejar de actualizar</button>}
                    <button className="btn sm" disabled={!running} onClick={onMessage}>{s.messageId ? 'Publicar en otro canal' : 'Crear mensaje de estado'}</button>
                </div>
            </div>
            {st?.messageError && <div className="alert danger">No se pudo actualizar el mensaje: {st.messageError}</div>}
        </div>
    );
}

// ───────────────────────────── Estadísticas ─────────────────────────────

const RANGES: Array<[string, string]> = [['1h', '1 hora'], ['6h', '6 horas'], ['24h', '24 horas'], ['7d', '7 días'], ['30d', '30 días']];
const num = (v: number | null, d = 0, unit = '') => (v === null ? '—' : `${v.toLocaleString('es-ES', { maximumFractionDigits: d })}${unit}`);

function ServerStats({ server }: { server: GameServer }) {
    const [range, setRange] = useState('24h');
    const [data, setData] = useState<ServerHistory | null>(null);
    const [loading, setLoading] = useState(false);
    const [hover, setHover] = useState<number | null>(null);
    const [table, setTable] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        get<ServerHistory>(`/servers/${server.id}/history?range=${range}`)
            .then(setData).catch(e => toast.error(errMsg(e))).finally(() => setLoading(false));
    }, [server.id, range]);
    useEffect(load, [load]);
    // Se refresca solo mientras está abierto.
    useEffect(() => { const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

    const pts = data?.points ?? [];
    const sum = data?.summary;
    const gap = (data?.bucketMs ?? 60_000) * 2.5;
    const hasTps = pts.some(p => p.tps !== null);
    const hasMspt = pts.some(p => p.mspt !== null);
    const hasCpu = pts.some(p => p.cpu !== null);
    const maxPlayers = pts.reduce((m, p) => Math.max(m, p.max ?? 0), 0);
    const common = { from: data?.from ?? 0, to: data?.to ?? 0, gapMs: gap, hover, onHover: setHover };

    return (
        <div className="stack">
            <div className="row between wrap">
                <div className="seg" role="group" aria-label="Rango de tiempo">
                    {RANGES.map(([v, l]) => <button key={v} type="button" className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>)}
                </div>
                <button className="btn sm ghost" onClick={() => setTable(t => !t)}>{table ? 'Ver gráficas' : 'Ver como tabla'}</button>
            </div>

            {!data ? <Spinner /> : sum!.samples === 0 ? (
                <div className="muted small">Aún no hay datos en este rango. Se guarda una muestra con cada consulta (los últimos 30 días).</div>
            ) : (
                <>
                    <div className="grid tiles">
                        <div className="tile"><div className="label">Disponibilidad</div><div className="value" style={{ color: (sum!.uptime ?? 0) >= 0.99 ? 'var(--ok)' : (sum!.uptime ?? 0) >= 0.9 ? 'var(--warn)' : 'var(--danger)' }}>{num(sum!.uptime === null ? null : sum!.uptime * 100, 1, '%')}</div></div>
                        <div className="tile"><div className="label">Pico de jugadores</div><div className="value">{num(sum!.peakPlayers)}</div><div className="muted small">{sum!.peakAt ? fmtTipTime(sum!.peakAt) : ' '}</div></div>
                        <div className="tile"><div className="label">Media de jugadores</div><div className="value">{num(sum!.avgPlayers, 1)}</div></div>
                        {sum!.avgTps !== null && <div className="tile"><div className="label">TPS medio</div><div className="value">{num(sum!.avgTps, 1)}</div><div className="muted small">Mínimo {num(sum!.minTps, 1)}</div></div>}
                        {sum!.avgMspt !== null && <div className="tile"><div className="label">MSPT medio</div><div className="value">{num(sum!.avgMspt, 1, ' ms')}</div></div>}
                        <div className="tile"><div className="label">Latencia media</div><div className="value">{num(sum!.avgLatency, 0, ' ms')}</div></div>
                    </div>

                    {table ? (
                        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                            <table>
                                <thead><tr><th>Hora</th><th>Estado</th><th>Jugadores (media / pico)</th>{hasTps && <th>TPS</th>}{hasMspt && <th>MSPT</th>}{hasCpu && <th>CPU</th>}<th>Latencia</th></tr></thead>
                                <tbody>
                                    {[...pts].reverse().map(p => (
                                        <tr key={p.t}>
                                            <td className="small">{fmtTipTime(p.t)}</td>
                                            <td className="small">{p.up >= 0.999 ? 'Online' : p.up <= 0.001 ? 'Offline' : `Intermitente (${Math.round(p.up * 100)}%)`}</td>
                                            <td>{num(p.players, 1)} / {num(p.peak)}</td>
                                            {hasTps && <td>{num(p.tps, 1)}</td>}
                                            {hasMspt && <td>{num(p.mspt, 1, ' ms')}</td>}
                                            {hasCpu && <td>{num(p.cpu, 0, '%')}</td>}
                                            <td>{num(p.latency, 0, ' ms')}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <>
                            <UptimeStrip points={pts} from={common.from} to={common.to} bucketMs={data.bucketMs} hover={hover} onHover={setHover} />
                            <div className={`charts ${loading ? 'loading' : ''}`}>
                                <TimeChart title="Jugadores (media)" points={pts.map(p => ({ t: p.t, v: p.players }))} decimals={1}
                                    reference={maxPlayers ? { value: maxPlayers, label: `Máx. ${maxPlayers}` } : undefined} {...common} />
                                {hasTps && <TimeChart title="TPS" points={pts.map(p => ({ t: p.t, v: p.tps }))} yMax={20} decimals={1} {...common} />}
                                {hasMspt && <TimeChart title="MSPT" points={pts.map(p => ({ t: p.t, v: p.mspt }))} unit=" ms" decimals={1}
                                    reference={{ value: 50, label: 'Límite 50 ms' }} {...common} />}
                                {hasCpu && <TimeChart title="CPU" points={pts.map(p => ({ t: p.t, v: p.cpu }))} unit="%" yMax={100} {...common} />}
                                <TimeChart title="Latencia" points={pts.map(p => ({ t: p.t, v: p.latency }))} unit=" ms" {...common} />
                            </div>
                            {server.type === 'minecraft' && !hasTps && <div className="hint">Para ver TPS, MSPT y CPU configura el puerto de métricas (Spark) del servidor.</div>}
                        </>
                    )}
                </>
            )}
        </div>
    );
}

// ───────────────────────────── Editor ─────────────────────────────

type Draft = { name: string; type: ServerKind; host: string; port: string; apiPort: string; enabled: boolean; linkPlayers: boolean };

function ServerEditor({ initial, onClose, onSaved }: { initial: GameServer | null; onClose: () => void; onSaved: () => void }) {
    const [d, setD] = useState<Draft>(() => initial
        ? { name: initial.name, type: initial.type, host: initial.host, port: initial.port ? String(initial.port) : '', apiPort: initial.apiPort ? String(initial.apiPort) : '', enabled: initial.enabled, linkPlayers: initial.linkPlayers }
        : { name: '', type: 'minecraft', host: '', port: '', apiPort: '', enabled: true, linkPlayers: true });
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [test, setTest] = useState<ServerStatus | null>(null);
    const set = (patch: Partial<Draft>) => { setD(x => ({ ...x, ...patch })); setTest(null); };

    const body = () => ({ ...d, name: d.name.trim(), host: d.host.trim(), port: d.port.trim() || null, apiPort: d.apiPort.trim() || null });
    const valid = () => {
        if (!d.host.trim()) { toast.error('Indica la IP o el dominio.'); return false; }
        if (d.type === 'hytale' && !d.apiPort.trim()) { toast.error('Para Hytale hace falta el puerto de la API.'); return false; }
        return true;
    };

    const runTest = async () => {
        if (!valid()) return;
        setTesting(true);
        try { setTest(await post<ServerStatus>('/servers/test', body())); } catch (e) { toast.error(errMsg(e)); }
        finally { setTesting(false); }
    };

    const save = async () => {
        if (!d.name.trim()) return toast.error('Ponle un nombre.');
        if (!valid()) return;
        setSaving(true);
        try {
            if (initial) await put(`/servers/${initial.id}`, body()); else await post('/servers', body());
            toast.ok(initial ? 'Servidor guardado' : 'Servidor añadido');
            onSaved();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal title={initial ? `Editar "${initial.name}"` : 'Añadir servidor'} onClose={onClose} footer={<>
            <button className="btn" onClick={runTest} disabled={testing}>{testing ? 'Probando…' : 'Probar conexión'}</button>
            <div className="grow" />
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </>}>
            <div className="seg">
                {(['minecraft', 'hytale'] as const).map(t => <button key={t} type="button" className={d.type === t ? 'on' : ''} onClick={() => set({ type: t })}>{TYPE_LABEL[t]}</button>)}
            </div>
            <label className="field">Nombre<input type="text" maxLength={60} value={d.name} onChange={e => set({ name: e.target.value })} placeholder={d.type === 'minecraft' ? 'Survival MCKB' : 'Hytale MCKB'} /></label>
            <label className="field">IP o dominio<input type="text" value={d.host} onChange={e => set({ host: e.target.value })} placeholder="mc.tudominio.com" spellCheck={false} /></label>
            <div className="grid cols-2">
                {d.type === 'minecraft' && (
                    <label className="field">Puerto del juego<input type="number" min={1} max={65535} value={d.port} onChange={e => set({ port: e.target.value })} placeholder="25565" /></label>
                )}
                <label className="field">{d.type === 'minecraft' ? 'Puerto de métricas (opcional)' : 'Puerto de la API (Nitrado Query)'}
                    <input type="number" min={1} max={65535} value={d.apiPort} onChange={e => set({ apiPort: e.target.value })} placeholder={d.type === 'minecraft' ? 'Spark /metrics' : 'Obligatorio'} />
                </label>
            </div>
            <span className="hint" style={{ marginTop: -6 }}>
                {d.type === 'minecraft'
                    ? 'Con el puerto de métricas se muestran TPS, MSPT y CPU. Para la lista completa de jugadores activa enable-query=true en server.properties.'
                    : 'El bot consulta https://IP:puerto/Nitrado/Query (se acepta el certificado autofirmado).'}
            </span>
            <Check checked={d.linkPlayers} onChange={linkPlayers => set({ linkPlayers })} label="Asociar jugadores con su usuario de Discord"
                hint="Usa lo que respondieron en las campañas de confirmación (p. ej. su nombre de Minecraft) para mencionarlos en el mensaje de estado." />
            <Check checked={d.enabled} onChange={enabled => set({ enabled })} label="Consultar este servidor" />

            {test && (
                <div className={`alert ${test.online ? 'info' : 'danger'}`}>
                    {test.online
                        ? <><b>✅ Responde</b> · {test.latencyMs} ms · {test.playersOnline}/{test.maxPlayers} jugadores{test.version ? ` · ${test.version}` : ''}{test.tps ? ` · TPS ${test.tps.m1.toFixed(1)}` : ''}</>
                        : <><b>❌ No responde:</b> {test.error}</>}
                    {test.warnings.map(w => <div key={w} className="small" style={{ marginTop: 4 }}>⚠️ {w}</div>)}
                </div>
            )}
        </Modal>
    );
}

function MessageModal({ server, channels, onClose, onDone }: { server: GameServer; channels: ReturnType<typeof useGuildData>['channels']; onClose: () => void; onDone: () => void }) {
    const [channelId, setChannelId] = useState(server.channelId ?? '');
    const [saving, setSaving] = useState(false);
    const create = async () => {
        if (!channelId) return toast.error('Elige un canal.');
        setSaving(true);
        try { await post(`/servers/${server.id}/message`, { channelId }); toast.ok('Mensaje de estado publicado'); onDone(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title={`Mensaje de estado · ${server.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={create}>Publicar</button></>}>
            <p className="hint" style={{ margin: 0 }}>El bot publicará un mensaje en el canal y lo editará en cada consulta. Si ya había uno, el anterior se queda en Discord sin actualizarse (puedes borrarlo a mano).</p>
            <label className="field">Canal<ChannelSelect value={channelId} channels={channels} onChange={setChannelId} /></label>
        </Modal>
    );
}
