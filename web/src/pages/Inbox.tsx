import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, put, type Msg } from '../api';
import { fmtDateTime, fmtRelative, fmtTime, SOURCE_LABEL } from '../format';
import { useLive } from '../live';
import { go } from '../nav';
import { Attachments, Avatar, Empty, FileDrop, Icon, Modal, Spinner, Switch, UserPicker, errMsg, toast, useUploads } from '../ui';

interface Conversation { userId: string; userTag: string | null; userAvatar: string | null; lastAt: number; unread: number; preview: string }

const dayLabel = (ts: number) => new Date(ts).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

export default function Inbox({ userId }: { userId?: string }) {
    const [convs, setConvs] = useState<Conversation[]>([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [thread, setThread] = useState<Msg[]>([]);
    const [threadLoading, setThreadLoading] = useState(false);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [newOpen, setNewOpen] = useState(false);
    const [forward, setForward] = useState<boolean | null>(null);
    const [pending, setPending] = useState<{ id: string; tag: string } | null>(null);
    const up = useUploads();
    const bottom = useRef<HTMLDivElement>(null);
    const userRef = useRef(userId);
    userRef.current = userId;

    const loadConvs = useCallback(() => {
        get<{ conversations: Conversation[] }>('/inbox/conversations')
            .then(r => setConvs(r.conversations))
            .catch(e => toast.error(errMsg(e)))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { loadConvs(); get<{ forwardToAdmin: boolean }>('/inbox/settings').then(s => setForward(s.forwardToAdmin)).catch(() => undefined); }, [loadConvs]);

    const markRead = useCallback((id: string) => { post(`/inbox/conversations/${id}/read`).then(loadConvs).catch(() => undefined); }, [loadConvs]);

    useEffect(() => {
        setText(''); up.clear();
        if (!userId) { setThread([]); return; }
        setThreadLoading(true);
        get<Msg[]>(`/inbox/conversations/${userId}`).then(m => { setThread(m); markRead(userId); }).catch(e => toast.error(errMsg(e))).finally(() => setThreadLoading(false));
    }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [thread, threadLoading]);

    useLive(e => {
        if (e.type === 'message:new') {
            const m = e.data as Msg;
            if (m.kind === 'dm') {
                if (m.userId && m.userId === userRef.current) {
                    setThread(t => t.some(x => x.id === m.id) ? t : [...t, m]);
                    if (m.direction === 'in') markRead(m.userId);
                }
                loadConvs();
            }
        } else if (e.type === 'inbox:read' || e.type === 'message:deleted') loadConvs();
    });

    const current = useMemo(() => {
        const c = convs.find(x => x.userId === userId);
        if (c) return { id: c.userId, tag: c.userTag ?? c.userId, avatar: c.userAvatar };
        if (userId) return { id: userId, tag: pending?.id === userId ? pending.tag : userId, avatar: null };
        return null;
    }, [convs, userId, pending]);

    const filtered = convs.filter(c => !filter || (c.userTag ?? c.userId).toLowerCase().includes(filter.toLowerCase()) || c.preview.toLowerCase().includes(filter.toLowerCase()));

    const send = async () => {
        if (!userId || (!text.trim() && !up.files.length)) return;
        setSending(true);
        try {
            await post(`/inbox/conversations/${userId}/reply`, { content: text, fileIds: up.files.map(f => f.id) });
            setText(''); up.clear();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSending(false); }
    };

    const toggleForward = async (v: boolean) => {
        setForward(v);
        try { await put('/inbox/settings', { forwardToAdmin: v }); } catch (e) { toast.error(errMsg(e)); setForward(!v); }
    };

    // agrupa por día
    const rows = useMemo(() => {
        const out: Array<{ sep?: string; msg?: Msg }> = [];
        let last = '';
        for (const m of thread) {
            const d = new Date(m.createdAt).toDateString();
            if (d !== last) { out.push({ sep: dayLabel(m.createdAt) }); last = d; }
            out.push({ msg: m });
        }
        return out;
    }, [thread]);

    return (
        <div className={`inbox ${userId ? 'has-thread' : ''}`}>
            <section className="inbox-list">
                <div className="head">
                    <div className="row between"><h2>Bandeja</h2><button className="btn sm primary" onClick={() => setNewOpen(true)}><Icon name="plus" size={14} /> Nueva</button></div>
                    <input type="search" placeholder="Buscar conversación…" value={filter} onChange={e => setFilter(e.target.value)} />
                    {forward !== null && (
                        <label className="row small muted" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
                            <span title="Además de guardarlos aquí, el bot te reenvía cada MD por Discord con un botón Responder">Reenviar MD recibidos al admin por Discord</span>
                            <Switch checked={forward} onChange={toggleForward} label="Reenviar al admin" />
                        </label>
                    )}
                </div>
                <div className="conv-items">
                    {loading && <div className="empty"><Spinner /></div>}
                    {!loading && filtered.length === 0 && <Empty title={filter ? 'Sin resultados' : 'Sin conversaciones'}>{filter ? '' : 'Cuando alguien escriba un MD al bot aparecerá aquí.'}</Empty>}
                    {filtered.map(c => (
                        <div key={c.userId} className={`conv ${c.userId === userId ? 'active' : ''}`} onClick={() => go(`inbox/${c.userId}`)}>
                            <Avatar src={c.userAvatar} name={c.userTag} size="lg" />
                            <div className="meta">
                                <div className="top"><b>{c.userTag ?? c.userId}</b><span>{fmtRelative(c.lastAt)}</span></div>
                                <div className="pv"><span>{c.preview || '…'}</span>{c.unread > 0 && <span className="unread">{c.unread}</span>}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="thread">
                {!current ? (
                    <div className="empty" style={{ margin: 'auto' }}><b>Selecciona una conversación</b>Aquí verás los mensajes y podrás responder con texto e imágenes.</div>
                ) : (
                    <>
                        <div className="thread-head">
                            <button className="btn ghost icon back-btn" onClick={() => go('inbox')} aria-label="Volver"><Icon name="back" /></button>
                            <Avatar src={current.avatar} name={current.tag} size="lg" />
                            <div className="grow"><b>{current.tag}</b><div className="muted small mono">{current.id}</div></div>
                            <a className="btn sm" href={`https://discord.com/users/${current.id}`} target="_blank" rel="noreferrer">Perfil en Discord</a>
                        </div>
                        <div className="msgs">
                            {threadLoading && <div className="empty"><Spinner /></div>}
                            {!threadLoading && thread.length === 0 && <div className="empty"><b>Aún no hay mensajes</b>Escribe abajo para iniciar la conversación por MD.</div>}
                            {rows.map((r, i) => r.sep
                                ? <div key={`s${i}`} className="day-sep">{r.sep}</div>
                                : <Bubble key={r.msg!.id} m={r.msg!} />)}
                            <div ref={bottom} />
                        </div>
                        <div className="composer">
                            {up.files.length > 0 || up.uploading ? <FileDrop up={up} compact /> : null}
                            <div className="row" style={{ alignItems: 'flex-end' }}>
                                {up.files.length === 0 && !up.uploading && <FileDrop up={up} compact />}
                                <textarea className="grow" rows={1} placeholder="Escribe una respuesta… (Enter envía · Shift+Enter nueva línea)" value={text} maxLength={2000}
                                    onChange={e => setText(e.target.value)} onPaste={up.onPaste}
                                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                                <button className="btn primary" disabled={sending || up.uploading || (!text.trim() && !up.files.length)} onClick={send}><Icon name="send" /> Enviar</button>
                            </div>
                        </div>
                    </>
                )}
            </section>

            {newOpen && (
                <Modal title="Nueva conversación" onClose={() => setNewOpen(false)}>
                    <p className="hint" style={{ margin: 0 }}>Elige un miembro del servidor para escribirle un MD desde el bot.</p>
                    <UserPicker onPick={m => { setPending({ id: m.id, tag: m.username }); setNewOpen(false); go(`inbox/${m.id}`); }} />
                </Modal>
            )}
        </div>
    );
}

function Bubble({ m }: { m: Msg }) {
    const out = m.direction === 'out';
    const auto = out && !['manual', 'reply'].includes(m.source);
    return (
        <div className={`bubble-row ${out ? 'out' : 'in'}`}>
            <div className={`bubble ${out ? 'out' : 'in'} ${m.status === 'failed' ? 'failed' : ''}`} title={fmtDateTime(m.createdAt)}>
                {m.content && <div className="txt">{m.content}</div>}
                {m.embed && (m.embed.title || m.embed.description) && (
                    <div className="embed" style={{ borderLeftColor: m.embed.color }}>
                        {m.embed.title && <b>{m.embed.title}</b>}
                        {m.embed.description && <div className="txt small">{m.embed.description}</div>}
                    </div>
                )}
                <Attachments files={m.files} />
                <div className="meta">
                    {auto && <span>🤖 {SOURCE_LABEL[m.source] ?? m.source} ·</span>}
                    <span>{fmtTime(m.createdAt)}</span>
                    {m.status === 'failed' && <span>· ❌ {m.error}</span>}
                </div>
            </div>
        </div>
    );
}
