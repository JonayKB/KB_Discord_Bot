import { useCallback, useEffect, useState } from 'react';
import { get, post, type Job, type Msg, type Status } from '../api';
import { fmtDuration, fmtRelative, fmtDateTime, SOURCE_LABEL } from '../format';
import { useLive } from '../live';
import { Avatar, Empty, PageHead, Spinner, Switch, errMsg, toast } from '../ui';
import { go } from '../nav';

export default function Dashboard() {
    const [status, setStatus] = useState<Status | null>(null);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [recent, setRecent] = useState<Msg[]>([]);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        Promise.all([get<Status>('/status'), get<Job[]>('/scheduler/jobs'), get<Msg[]>('/messages/history?limit=8')])
            .then(([s, j, r]) => { setStatus(s); setJobs(j); setRecent(r); setError(null); })
            .catch(e => setError(errMsg(e)));
    }, []);

    useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
    useLive(e => { if (['message:new', 'job:updated', 'modules:changed'].includes(e.type)) load(); });

    const toggle = async (id: string, enabled: boolean) => {
        try { await post(`/modules/${id}/enabled`, { enabled }); load(); }
        catch (e) { toast.error(errMsg(e)); }
    };

    if (error && !status) return <div className="page"><div className="alert danger">{error}</div></div>;
    if (!status) return <div className="page"><Spinner /></div>;

    const upcoming = jobs.filter(j => j.enabled && j.nextRunAt).sort((a, b) => a.nextRunAt! - b.nextRunAt!).slice(0, 4);
    const s = status.stats;
    return (
        <div className="page stack" style={{ gap: 22 }}>
            <PageHead title="Resumen" subtitle={status.guild ? `${status.guild.name} · ${status.guild.memberCount} miembros` : 'Conectando con el servidor…'}>
                <span className={`badge ${status.ready ? 'ok' : 'warn'}`}><span className={`dot ${status.ready ? 'on' : ''}`} /> {status.ready ? `Bot en línea${status.bot ? ` · ${status.bot.tag}` : ''}` : 'Conectando…'}</span>
                <span className="badge">Ping {status.wsPingMs} ms</span>
                <span className="badge">Activo desde hace {fmtDuration(status.uptimeMs)}</span>
            </PageHead>

            <div className="grid tiles">
                <div className="tile link" onClick={() => go('history')}><div className="label">Enviados (24 h)</div><div className="value">{s.sent24h}</div></div>
                <div className="tile link" onClick={() => go('history')}><div className="label">Fallidos (24 h)</div><div className="value" style={{ color: s.failed24h ? 'var(--danger)' : undefined }}>{s.failed24h}</div></div>
                <div className="tile link" onClick={() => go('inbox')}><div className="label">Recibidos (24 h)</div><div className="value">{s.received24h}</div></div>
                <div className="tile link" onClick={() => go('inbox')}><div className="label">Sin leer</div><div className="value" style={{ color: s.unread ? 'var(--accent)' : undefined }}>{s.unread}</div></div>
                <div className="tile link" onClick={() => go('scheduler')}><div className="label">Tareas activas</div><div className="value">{s.activeJobs}</div></div>
                <div className="tile link" onClick={() => go('confirmations')}><div className="label">Confirmados</div><div className="value">{s.confirmed}</div></div>
            </div>

            <div className="grid cols-2">
                <div className="card">
                    <div className="card-head"><h2>Próximos envíos</h2><button className="btn sm" onClick={() => go('scheduler')}>Gestionar</button></div>
                    {upcoming.length === 0 ? <Empty title="Nada programado">Crea una tarea en Programación.</Empty> : (
                        <div className="stack" style={{ gap: 10 }}>
                            {upcoming.map(j => (
                                <div key={j.id} className="row between">
                                    <div className="grow"><b className="ellipsis" style={{ display: 'block' }}>{j.name}</b><span className="muted small">{fmtDateTime(j.nextRunAt!, j.timezone)}</span></div>
                                    <span className="badge accent">{fmtRelative(j.nextRunAt!)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="card">
                    <div className="card-head"><h2>Módulos</h2><button className="btn sm" onClick={() => go('modules')}>Detalles</button></div>
                    <div className="stack" style={{ gap: 10 }}>
                        {status.modules.map(m => (
                            <div key={m.id} className="row between">
                                <div><b>{m.name}</b> {m.error && <span className="badge danger">Error</span>}</div>
                                <Switch checked={m.enabled} onChange={v => toggle(m.id, v)} label={`Activar ${m.name}`} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="card tight">
                <div className="card-head" style={{ padding: '16px 18px 0' }}><h2>Actividad reciente</h2><button className="btn sm" onClick={() => go('history')}>Ver historial</button></div>
                {recent.length === 0 ? <Empty title="Aún no hay mensajes">Los mensajes enviados y recibidos aparecerán aquí.</Empty> : (
                    <div className="table-wrap"><table><tbody>
                        {recent.map(m => (
                            <tr key={m.id} className="click" onClick={() => m.userId ? go(`inbox/${m.userId}`) : go('history')}>
                                <td className="shrink"><span className={`badge ${m.direction === 'in' ? 'accent' : ''}`}>{m.direction === 'in' ? '↓ Recibido' : '↑ Enviado'}</span></td>
                                <td className="shrink"><div className="row"><Avatar src={m.userAvatar} name={m.userTag ?? m.channelName} size="sm" /><b>{m.kind === 'channel' ? `#${m.channelName ?? m.channelId}` : (m.userTag ?? m.userId)}</b></div></td>
                                <td><span className="ellipsis" style={{ display: 'block', maxWidth: 420 }}>{m.content || (m.embed?.title ? `📋 ${m.embed.title}` : m.files.length ? '📎 Adjunto' : '—')}</span></td>
                                <td className="shrink"><span className="badge">{SOURCE_LABEL[m.source] ?? m.source}</span></td>
                                <td className="shrink muted small">{fmtRelative(m.createdAt)}</td>
                            </tr>
                        ))}
                    </tbody></table></div>
                )}
            </div>
        </div>
    );
}
