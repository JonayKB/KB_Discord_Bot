import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { del, get, type Msg } from '../api';
import { fmtDateTime, SOURCE_LABEL } from '../format';
import { useLive } from '../live';
import { go } from '../nav';
import { Attachments, Avatar, Empty, PageHead, Spinner, errMsg, toast, useConfirm } from '../ui';

const PAGE = 50;

export default function History() {
    const confirm = useConfirm();
    const [rows, setRows] = useState<Msg[]>([]);
    const [loading, setLoading] = useState(true);
    const [more, setMore] = useState(false);
    const [open, setOpen] = useState<number | null>(null);
    const [direction, setDirection] = useState('');
    const [kind, setKind] = useState('');
    const [source, setSource] = useState('');
    const [status, setStatus] = useState('');
    const [q, setQ] = useState('');
    const [qDebounced, setQDebounced] = useState('');
    const reload = useRef<() => void>(() => undefined);

    useEffect(() => { const t = setTimeout(() => setQDebounced(q), 300); return () => clearTimeout(t); }, [q]);

    const query = useCallback((before?: number) => {
        const p = new URLSearchParams({ limit: String(PAGE) });
        if (direction) p.set('direction', direction);
        if (kind) p.set('kind', kind);
        if (source) p.set('source', source);
        if (status) p.set('status', status);
        if (qDebounced) p.set('q', qDebounced);
        if (before) p.set('before', String(before));
        return get<Msg[]>(`/messages/history?${p}`);
    }, [direction, kind, source, status, qDebounced]);

    const load = useCallback(() => {
        setLoading(true);
        query().then(r => { setRows(r); setMore(r.length === PAGE); }).catch(e => toast.error(errMsg(e))).finally(() => setLoading(false));
    }, [query]);
    reload.current = load;
    useEffect(load, [load]);

    useLive(e => { if (e.type === 'message:new' || e.type === 'message:deleted') reload.current(); });

    const loadMore = async () => {
        try { const r = await query(rows[rows.length - 1]?.id); setRows(x => [...x, ...r]); setMore(r.length === PAGE); }
        catch (e) { toast.error(errMsg(e)); }
    };

    const remove = async (m: Msg) => {
        if (!(await confirm({ title: 'Quitar del historial', message: 'Se borra solo el registro del panel; el mensaje en Discord no se toca.', confirmLabel: 'Quitar', danger: true }))) return;
        try { await del(`/messages/history/${m.id}`); setRows(r => r.filter(x => x.id !== m.id)); } catch (e) { toast.error(errMsg(e)); }
    };

    return (
        <div className="page">
            <PageHead title="Historial" subtitle="Todos los mensajes enviados y recibidos por el bot." />
            <div className="card" style={{ marginBottom: 16 }}>
                <div className="row wrap">
                    <input type="search" style={{ maxWidth: 280 }} placeholder="Buscar texto o usuario…" value={q} onChange={e => setQ(e.target.value)} />
                    <select style={{ width: 'auto' }} value={direction} onChange={e => setDirection(e.target.value)}><option value="">Enviados y recibidos</option><option value="out">Solo enviados</option><option value="in">Solo recibidos</option></select>
                    <select style={{ width: 'auto' }} value={kind} onChange={e => setKind(e.target.value)}><option value="">MD y canales</option><option value="dm">Solo MD</option><option value="channel">Solo canales</option></select>
                    <select style={{ width: 'auto' }} value={source} onChange={e => setSource(e.target.value)}>
                        <option value="">Cualquier origen</option>
                        {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <select style={{ width: 'auto' }} value={status} onChange={e => setStatus(e.target.value)}><option value="">Cualquier estado</option><option value="sent">Enviado</option><option value="failed">Fallido</option><option value="received">Recibido</option></select>
                </div>
            </div>

            <div className="card tight">
                {loading ? <div className="empty"><Spinner /></div> : rows.length === 0 ? <Empty title="Sin resultados">Prueba con otros filtros.</Empty> : (
                    <div className="table-wrap"><table>
                        <thead><tr><th>Fecha</th><th>Dirección</th><th>Usuario / canal</th><th>Mensaje</th><th>Origen</th><th>Estado</th></tr></thead>
                        <tbody>
                            {rows.map(m => (
                                <Fragment key={m.id}>
                                    <tr className={`click ${open === m.id ? 'sel' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
                                        <td className="shrink muted small">{fmtDateTime(m.createdAt)}</td>
                                        <td className="shrink"><span className={`badge ${m.direction === 'in' ? 'accent' : ''}`}>{m.direction === 'in' ? '↓ Recibido' : '↑ Enviado'}</span></td>
                                        <td className="shrink"><div className="row"><Avatar src={m.userAvatar} name={m.userTag ?? m.channelName} size="sm" /><b>{m.kind === 'channel' ? `#${m.channelName ?? m.channelId}` : (m.userTag ?? m.userId)}</b></div></td>
                                        <td><span className="ellipsis" style={{ display: 'block', maxWidth: 380 }}>{m.content || (m.embed?.title ? `📋 ${m.embed.title}` : m.files.length ? '📎 Adjunto' : '—')}{m.files.length > 0 && m.content ? ' 📎' : ''}</span></td>
                                        <td className="shrink"><span className="badge">{SOURCE_LABEL[m.source] ?? m.source}</span></td>
                                        <td className="shrink">{m.status === 'failed' ? <span className="badge danger">Fallido</span> : m.status === 'received' ? <span className="badge accent">Recibido</span> : <span className="badge ok">Enviado</span>}</td>
                                    </tr>
                                    {open === m.id && (
                                        <tr className="expand"><td colSpan={6}>
                                            <div className="stack" style={{ gap: 10 }}>
                                                {m.content && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>}
                                                {m.embed && <div className="card" style={{ borderLeft: `4px solid ${m.embed.color ?? 'var(--accent)'}`, padding: 12 }}>{m.embed.title && <b>{m.embed.title}</b>}<div style={{ whiteSpace: 'pre-wrap' }}>{m.embed.description}</div>{m.embed.footer && <div className="muted small">{m.embed.footer}</div>}</div>}
                                                <div className="row wrap"><Attachments files={m.files} className="att" /></div>
                                                {m.error && <div className="alert danger">{m.error}</div>}
                                                <div className="row wrap">
                                                    {m.kind === 'dm' && m.userId && <button className="btn sm" onClick={() => go(`inbox/${m.userId}`)}>Ver conversación</button>}
                                                    <button className="btn sm danger" onClick={() => remove(m)}>Quitar del historial</button>
                                                    <span className="muted small">ID {m.id}{m.sourceRef ? ` · ref ${m.sourceRef}` : ''}</span>
                                                </div>
                                            </div>
                                        </td></tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table></div>
                )}
                {more && !loading && <div className="row" style={{ justifyContent: 'center', padding: 14 }}><button className="btn" onClick={loadMore}>Cargar más</button></div>}
            </div>
        </div>
    );
}
