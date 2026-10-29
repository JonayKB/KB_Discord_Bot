import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    del, get, post, put,
    type Category, type ModuleInfo, type Ticket, type TicketButtonStyle, type TicketMessage, type TicketPanel, type TicketQuestion, type TicketType, type TicketsConfig,
} from '../api';
import { fmtDateTime, fmtRelative, fmtTime } from '../format';
import { useLive } from '../live';
import { go } from '../nav';
import {
    Avatar, Check, ChannelSelect, Empty, FileDrop, Icon, Modal, PageHead, RoleChecklist, Spinner, errMsg, toast, useConfirm, useGuildData, useUploads,
} from '../ui';

const pad = (n: number) => String(n).padStart(4, '0');
const dayLabel = (ts: number) => new Date(ts).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const IMG = /\.(png|jpe?g|gif|webp)(\?|$)/i;

/** #/tickets → bandeja · #/tickets/<id> → ticket · #/tickets/panels · #/tickets/settings */
export default function Tickets({ sub }: { sub?: string }) {
    if (sub === 'panels') return <PanelsPage />;
    if (sub === 'settings') return <SettingsPage />;
    return <TicketsInbox ticketId={sub ? Number(sub) : null} />;
}

function SubNav({ active }: { active: 'inbox' | 'panels' | 'settings' }) {
    return (
        <div className="seg" role="tablist">
            {([['inbox', 'Tickets', 'tickets'], ['panels', 'Paneles', 'tickets/panels'], ['settings', 'Ajustes', 'tickets/settings']] as const).map(([id, l, path]) => (
                <button key={id} type="button" role="tab" aria-selected={active === id} className={active === id ? 'on' : ''} onClick={() => go(path)}>{l}</button>
            ))}
        </div>
    );
}

function useModuleRunning() {
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    useEffect(() => { get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'tickets') ?? null)).catch(() => undefined); }, []);
    useLive(e => { if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'tickets') ?? null); });
    return mod?.running ?? true;
}

// ───────────────────────────── Bandeja de tickets ─────────────────────────────

function TicketsInbox({ ticketId }: { ticketId: number | null }) {
    const confirm = useConfirm();
    const running = useModuleRunning();
    const [status, setStatus] = useState<'open' | 'closed' | ''>('open');
    const [q, setQ] = useState('');
    const [list, setList] = useState<Ticket[] | null>(null);
    const [counts, setCounts] = useState({ open: 0, waiting: 0 });
    const [ticket, setTicket] = useState<Ticket | null>(null);
    const [messages, setMessages] = useState<TicketMessage[]>([]);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const [closing, setClosing] = useState(false);
    const up = useUploads();
    const bottom = useRef<HTMLDivElement>(null);
    const current = useRef(ticketId);
    current.current = ticketId;

    const loadList = useCallback(() => {
        get<{ counts: { open: number; waiting: number }; tickets: Ticket[] }>(`/tickets?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
            .then(r => { setList(r.tickets); setCounts(r.counts); }).catch(e => toast.error(errMsg(e)));
    }, [status, q]);
    useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList, q]);

    const loadTicket = useCallback(() => {
        if (!ticketId) { setTicket(null); setMessages([]); return; }
        get<{ ticket: Ticket; messages: TicketMessage[] }>(`/tickets/${ticketId}`)
            .then(r => { setTicket(r.ticket); setMessages(r.messages); })
            .catch(e => { toast.error(errMsg(e)); go('tickets'); });
    }, [ticketId]);
    useEffect(() => { setText(''); up.clear(); loadTicket(); }, [loadTicket]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages]);

    useLive(e => {
        if (e.type === 'tickets:message') {
            const m = e.data as TicketMessage;
            if (m.ticketId === current.current) setMessages(list => list.some(x => x.id === m.id) ? list : [...list, m]);
            loadList();
        } else if (e.type === 'tickets:changed') {
            loadList();
            if (!e.data?.id || e.data.id === current.current) loadTicket();
        }
    });

    const send = async () => {
        if (!ticket || (!text.trim() && !up.files.length)) return;
        setSending(true);
        try { await post(`/tickets/${ticket.id}/reply`, { content: text, fileIds: up.files.map(f => f.id) }); setText(''); up.clear(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSending(false); }
    };

    const claim = async () => {
        if (!ticket) return;
        try { await post(`/tickets/${ticket.id}/claim`); } catch (e) { toast.error(errMsg(e)); }
    };

    const remove = async () => {
        if (!ticket || !(await confirm({ title: `Borrar ticket #${pad(ticket.number)}`, message: 'Se borra del historial junto con su conversación. No se puede deshacer.', confirmLabel: 'Borrar', danger: true }))) return;
        try { await del(`/tickets/${ticket.id}`); go('tickets'); toast.ok('Ticket borrado'); } catch (e) { toast.error(errMsg(e)); }
    };

    const rows = useMemo(() => {
        const out: Array<{ sep?: string; msg?: TicketMessage }> = [];
        let last = '';
        for (const m of messages) {
            const d = new Date(m.createdAt).toDateString();
            if (d !== last) { out.push({ sep: dayLabel(m.createdAt) }); last = d; }
            out.push({ msg: m });
        }
        return out;
    }, [messages]);

    return (
        <div className={`inbox ${ticketId ? 'has-thread' : ''}`}>
            <section className="inbox-list">
                <div className="head">
                    <div className="row between"><h2>Tickets</h2><span className="muted small">{counts.open} abiertos{counts.waiting ? ` · ${counts.waiting} esperando` : ''}</span></div>
                    <SubNav active="inbox" />
                    <div className="seg">
                        {([['open', 'Abiertos'], ['closed', 'Cerrados'], ['', 'Todos']] as const).map(([v, l]) => <button key={v} type="button" className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{l}</button>)}
                    </div>
                    <input type="search" placeholder="Buscar por usuario, tipo o número…" value={q} onChange={e => setQ(e.target.value)} />
                    {!running && <div className="alert">El módulo <b>Tickets</b> está desactivado: los botones no responden. <a href="#/modules">Activar</a></div>}
                </div>
                <div className="conv-items">
                    {!list && <div className="empty"><Spinner /></div>}
                    {list?.length === 0 && <Empty title="No hay tickets">{status === 'open' ? 'Cuando alguien abra uno desde el panel aparecerá aquí.' : ''}</Empty>}
                    {list?.map(t => (
                        <div key={t.id} className={`conv ${t.id === ticketId ? 'active' : ''}`} onClick={() => go(`tickets/${t.id}`)}>
                            <Avatar src={t.userAvatar} name={t.userTag} size="lg" />
                            <div className="meta">
                                <div className="top"><b>{t.userTag ?? t.userId}</b><span>{fmtRelative(t.lastMessageAt)}</span></div>
                                <div className="pv">
                                    <span><span className="ticket-num">#{pad(t.number)}</span> · {t.typeLabel}</span>
                                    {t.status === 'closed' ? <span className="badge">Cerrado</span>
                                        : t.lastKind === 'user' || t.messageCount === 0 ? <span className="badge warn">Esperando</span>
                                            : <span className="badge ok">Respondido</span>}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="thread">
                {!ticket ? (
                    <div className="empty" style={{ margin: 'auto' }}><b>Selecciona un ticket</b>Aquí verás la conversación y podrás responder, atenderlo o cerrarlo.</div>
                ) : (
                    <>
                        <div className="thread-head">
                            <button className="btn ghost icon back-btn" onClick={() => go('tickets')} aria-label="Volver"><Icon name="back" /></button>
                            <Avatar src={ticket.userAvatar} name={ticket.userTag} size="lg" />
                            <div className="grow">
                                <b>{ticket.userTag ?? ticket.userId}</b> <span className="ticket-num">#{pad(ticket.number)}</span>
                                <div className="muted small">{ticket.typeLabel} · {ticket.status === 'open' ? 'Abierto' : 'Cerrado'} {fmtRelative(ticket.status === 'open' ? ticket.createdAt : ticket.closedAt!)}</div>
                            </div>
                            <a className="btn sm ghost" href={`/api/tickets/${ticket.id}/transcript`} download title="Descargar la conversación como HTML"><Icon name="list" size={14} /> Transcripción</a>
                            {ticket.status === 'open' ? (
                                <>
                                    {!ticket.claimedById && <button className="btn sm" disabled={!running} onClick={claim}>🙋 Atender</button>}
                                    <button className="btn sm danger" disabled={!running} onClick={() => setClosing(true)}>🔒 Cerrar</button>
                                </>
                            ) : <button className="btn sm danger" onClick={remove} aria-label="Borrar del historial"><Icon name="trash" size={14} /></button>}
                        </div>
                        <dl className="ticket-info">
                            <div><dt>Abierto:</dt><dd>{fmtDateTime(ticket.createdAt)}</dd></div>
                            <div><dt>Atendido por:</dt><dd>{ticket.claimedByName ?? '—'}</dd></div>
                            {ticket.answers.map(a => <div key={a.question}><dt>{a.question}:</dt><dd>{a.answer || '—'}</dd></div>)}
                            {ticket.status === 'closed' && <div><dt>Cerrado por:</dt><dd>{ticket.closedByName ?? '—'}{ticket.closeReason ? ` · ${ticket.closeReason}` : ' · sin motivo'}</dd></div>}
                        </dl>
                        <div className="msgs">
                            {rows.map((r, i) => r.sep ? <div key={`s${i}`} className="day-sep">{r.sep}</div> : <TicketBubble key={r.msg!.id} m={r.msg!} />)}
                            <div ref={bottom} />
                        </div>
                        {ticket.status === 'open' ? (
                            <div className="composer">
                                {up.files.length > 0 || up.uploading ? <FileDrop up={up} compact /> : null}
                                <div className="row" style={{ alignItems: 'flex-end' }}>
                                    {up.files.length === 0 && !up.uploading && <FileDrop up={up} compact />}
                                    <textarea className="grow" rows={1} placeholder="Responder en el ticket… (Enter envía · Shift+Enter nueva línea)" value={text} maxLength={1900}
                                        onChange={e => setText(e.target.value)} onPaste={up.onPaste}
                                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                                    <button className="btn primary" disabled={!running || sending || up.uploading || (!text.trim() && !up.files.length)} onClick={send}><Icon name="send" /> Enviar</button>
                                </div>
                            </div>
                        ) : <div className="closed-bar">🔒 Ticket cerrado. Se conserva aquí como historial.</div>}
                    </>
                )}
            </section>

            {closing && ticket && <CloseModal ticket={ticket} onClose={() => setClosing(false)} />}
        </div>
    );
}

function TicketBubble({ m }: { m: TicketMessage }) {
    if (m.kind === 'system') return <div className="sys-msg" title={fmtDateTime(m.createdAt)}>{m.content}</div>;
    const out = m.kind !== 'user';
    return (
        <div className={`bubble-row ${out ? 'out' : 'in'}`}>
            <div className={`bubble ${out ? 'out' : 'in'}`} title={fmtDateTime(m.createdAt)}>
                <div className="author">{m.authorName ?? 'Desconocido'}{m.kind === 'panel' ? ' · panel' : m.kind === 'staff' ? ' · staff' : ''}</div>
                {m.content && <div className="txt">{m.content}</div>}
                {m.attachments.map(a => IMG.test(a.url) || IMG.test(a.name)
                    ? <a key={a.url} href={a.url} target="_blank" rel="noreferrer"><img className="att" src={a.url} alt={a.name} loading="lazy" /></a>
                    : <a key={a.url} className="file-link" href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a>)}
                <div className="meta"><span>{fmtTime(m.createdAt)}</span></div>
            </div>
        </div>
    );
}

function CloseModal({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const close = async (withReason: boolean) => {
        setSaving(true);
        try { await post(`/tickets/${ticket.id}/close`, { reason: withReason ? reason : '' }); toast.ok(`Ticket #${pad(ticket.number)} cerrado`); onClose(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title={`Cerrar ticket #${pad(ticket.number)}`} onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <div className="grow" />
            <button className="btn" disabled={saving} onClick={() => close(false)}>Cerrar sin motivo</button>
            <button className="btn danger" disabled={saving || !reason.trim()} onClick={() => close(true)}>Cerrar con motivo</button>
        </>}>
            <label className="field">Motivo (opcional)
                <textarea rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ej.: Resuelto, el usuario ya puede entrar al servidor" autoFocus />
            </label>
            <p className="hint" style={{ margin: 0 }}>El usuario recibirá un aviso con el motivo (según los Ajustes) y el canal se borrará o bloqueará.</p>
        </Modal>
    );
}

// ───────────────────────────── Paneles ─────────────────────────────

const STYLE_LABEL: Record<TicketButtonStyle, string> = { primary: 'Azul', secondary: 'Gris', success: 'Verde', danger: 'Rojo' };
const STYLE_COLOR: Record<TicketButtonStyle, string> = { primary: '#5865f2', secondary: '#4e5058', success: '#248046', danger: '#da373c' };

function PanelsPage() {
    const running = useModuleRunning();
    const guild = useGuildData();
    const [panels, setPanels] = useState<TicketPanel[] | null>(null);
    const [editing, setEditing] = useState<TicketPanel | 'new' | null>(null);
    const [publishing, setPublishing] = useState<TicketPanel | null>(null);
    const [deleting, setDeleting] = useState<TicketPanel | null>(null);
    const load = useCallback(() => { get<TicketPanel[]>('/tickets/panels').then(setPanels).catch(e => toast.error(errMsg(e))); }, []);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'tickets:changed') load(); });

    const channelName = (id: string | null) => guild.channels.find(c => c.id === id)?.name;
    const done = (warnings: string[], ok: string) => { warnings.length ? warnings.forEach(w => toast.error(w)) : toast.ok(ok); load(); };

    return (
        <div className="page">
            <PageHead title="Tickets" subtitle="El panel es el mensaje con botones desde el que los miembros abren tickets. Cada botón es un tipo de ticket con su configuración.">
                <button className="btn primary" disabled={!running} onClick={() => setEditing('new')}><Icon name="plus" /> Nuevo panel</button>
            </PageHead>
            <div style={{ marginBottom: 16 }}><SubNav active="panels" /></div>
            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Tickets</b> está desactivado: los botones no responden. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            {!panels ? <Spinner /> : panels.length === 0 ? (
                <div className="card"><Empty title="Aún no hay paneles">Crea uno y publícalo en un canal para que los miembros puedan abrir tickets.</Empty></div>
            ) : (
                <div className="stack">
                    {panels.map(p => (
                        <div key={p.id} className="card stack">
                            <div className="row between wrap">
                                <h2>{p.name}</h2>
                                <div className="row">
                                    <button className="btn sm" disabled={!running} onClick={() => setPublishing(p)}>{p.messageId ? 'Publicar en otro canal' : 'Publicar'}</button>
                                    <button className="btn sm" disabled={!running} onClick={() => setEditing(p)}><Icon name="edit" size={14} /> Editar</button>
                                    <button className="btn sm danger" disabled={!running} onClick={() => setDeleting(p)} aria-label="Eliminar panel"><Icon name="trash" size={14} /></button>
                                </div>
                            </div>
                            <PanelPreview panel={p} />
                            <div className="muted small">{p.messageId ? <>Publicado en <b>#{channelName(p.channelId) ?? p.channelId}</b></> : 'Sin publicar.'}</div>
                        </div>
                    ))}
                </div>
            )}

            {editing && <PanelEditor initial={editing === 'new' ? null : editing} guild={guild} onClose={() => setEditing(null)} onSaved={(w, isNew) => { setEditing(null); done(w, isNew ? 'Panel creado' : 'Panel guardado'); }} />}
            {publishing && <PublishModal panel={publishing} channels={guild.channels} onClose={() => setPublishing(null)} onDone={() => { setPublishing(null); done([], 'Panel publicado'); }} />}
            {deleting && <DeletePanelModal panel={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); done([], 'Panel eliminado'); }} />}
        </div>
    );
}

/** Así se verá el mensaje en Discord. */
function PanelPreview({ panel }: { panel: Pick<TicketPanel, 'title' | 'description' | 'color' | 'types'> }) {
    return (
        <div className="dc">
            <div className="dc-embed" style={{ marginLeft: 0, borderLeftColor: panel.color }}>
                <div className="t">{panel.title || 'Tickets'}</div>
                {panel.description && <div className="d">{panel.description}</div>}
            </div>
            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                {panel.types.map((t, i) => (
                    <span key={t.id ?? i} style={{ background: STYLE_COLOR[t.style], color: '#fff', borderRadius: 4, padding: '6px 14px', fontSize: 14, fontWeight: 500 }}>
                        {t.emoji && `${t.emoji} `}{t.label || 'Botón'}
                    </span>
                ))}
            </div>
        </div>
    );
}

const emptyType = (): TicketType => ({ label: 'Soporte', emoji: '🎫', style: 'primary', categoryId: null, supportRoleIds: [], nameTemplate: 'ticket-{number}', welcome: '', questions: [], maxOpen: 1 });

function PanelEditor({ initial, guild, onClose, onSaved }: { initial: TicketPanel | null; guild: ReturnType<typeof useGuildData>; onClose: () => void; onSaved: (w: string[], isNew: boolean) => void }) {
    const [d, setD] = useState(() => initial
        ? { name: initial.name, title: initial.title, description: initial.description, color: initial.color, types: initial.types.map(t => ({ ...t, questions: t.questions.map(q => ({ ...q })) })) }
        : { name: 'Soporte', title: '🎫 Tickets', description: 'Pulsa un botón para abrir un ticket.', color: '#5865F2', types: [emptyType()] });
    const [channelId, setChannelId] = useState('');
    const [open, setOpen] = useState(0);
    const [categories, setCategories] = useState<Category[]>([]);
    const [saving, setSaving] = useState(false);
    useEffect(() => { get<Category[]>('/guild/categories').then(setCategories).catch(() => undefined); }, []);

    const setType = (i: number, patch: Partial<TicketType>) => setD(x => ({ ...x, types: x.types.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
    const setQ = (i: number, n: number, patch: Partial<TicketQuestion>) => setType(i, { questions: d.types[i].questions.map((q, k) => (k === n ? { ...q, ...patch } : q)) });

    const save = async () => {
        if (!d.name.trim()) return toast.error('Ponle un nombre al panel.');
        if (d.types.some(t => !t.label.trim())) return toast.error('Cada botón necesita un texto.');
        if (d.types.some(t => t.questions.some(q => !q.label.trim()))) return toast.error('Hay preguntas sin texto.');
        setSaving(true);
        try {
            const r = initial
                ? await put<{ warnings: string[] }>(`/tickets/panels/${initial.id}`, d)
                : await post<{ warnings: string[] }>('/tickets/panels', { ...d, channelId });
            onSaved(r.warnings, !initial);
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal wide title={initial ? `Editar "${initial.name}"` : 'Nuevo panel de tickets'} onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : initial ? 'Guardar' : channelId ? 'Crear y publicar' : 'Crear'}</button>
        </>}>
            <div className="grid cols-2" style={{ alignItems: 'start' }}>
                <div className="stack">
                    <label className="field">Nombre (solo para el panel)<input type="text" maxLength={80} value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></label>
                    {!initial && <label className="field">Publicar en el canal<ChannelSelect value={channelId} channels={guild.channels} onChange={setChannelId} /><span className="hint">Puedes dejarlo vacío y publicarlo después.</span></label>}
                    <div className="row">
                        <label className="field grow">Título<input type="text" maxLength={256} value={d.title} onChange={e => setD({ ...d, title: e.target.value })} /></label>
                        <label className="field">Color<input type="color" value={d.color} onChange={e => setD({ ...d, color: e.target.value.toUpperCase() })} /></label>
                    </div>
                    <label className="field">Descripción<textarea rows={3} maxLength={3000} value={d.description} onChange={e => setD({ ...d, description: e.target.value })} /></label>
                </div>
                <div className="stack"><span className="small muted">Vista previa</span><PanelPreview panel={d} /></div>
            </div>

            <div className="sep" />
            <div className="row between"><b>Botones (tipos de ticket)</b><span className="hint">{d.types.length}/25</span></div>
            {d.types.map((t, i) => (
                <div key={t.id ?? `n${i}`} className="tile stack" style={{ gap: 10 }}>
                    <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === i ? -1 : i)}>
                        <b>{t.emoji} {t.label || 'Sin texto'}</b>
                        <div className="row">
                            <span className="muted small">{open === i ? 'Ocultar' : 'Configurar'}</span>
                            <button type="button" className="btn sm danger" disabled={d.types.length === 1} onClick={e => { e.stopPropagation(); setD({ ...d, types: d.types.filter((_, j) => j !== i) }); }} aria-label="Quitar botón"><Icon name="trash" size={14} /></button>
                        </div>
                    </div>
                    {open === i && (
                        <>
                            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                                <label className="field" style={{ width: 90 }}>Emoji<input type="text" maxLength={64} value={t.emoji} onChange={e => setType(i, { emoji: e.target.value })} /></label>
                                <label className="field grow">Texto del botón<input type="text" maxLength={80} value={t.label} onChange={e => setType(i, { label: e.target.value })} /></label>
                                <label className="field">Color
                                    <select value={t.style} onChange={e => setType(i, { style: e.target.value as TicketButtonStyle })}>
                                        {(Object.keys(STYLE_LABEL) as TicketButtonStyle[]).map(s => <option key={s} value={s}>{STYLE_LABEL[s]}</option>)}
                                    </select>
                                </label>
                            </div>
                            <div className="grid cols-2">
                                <label className="field">Categoría donde se crean
                                    <select value={t.categoryId ?? ''} onChange={e => setType(i, { categoryId: e.target.value || null })}>
                                        <option value="">— Sin categoría —</option>
                                        {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select>
                                </label>
                                <label className="field">Nombre del canal
                                    <input type="text" maxLength={80} value={t.nameTemplate} onChange={e => setType(i, { nameTemplate: e.target.value })} spellCheck={false} />
                                    <span className="hint">Variables: {'{number}'}, {'{username}'}, {'{type}'}</span>
                                </label>
                            </div>
                            <RoleChecklist label="Roles de soporte (ven y atienden estos tickets)" hint="Además, cualquiera con permiso de «Gestionar canales» puede atenderlos."
                                roles={guild.roles} value={t.supportRoleIds} onChange={supportRoleIds => setType(i, { supportRoleIds })} />
                            <label className="field">Mensaje de bienvenida en el ticket
                                <textarea rows={3} maxLength={3000} value={t.welcome} onChange={e => setType(i, { welcome: e.target.value })}
                                    placeholder="Hola {mention}, gracias por abrir un ticket. El equipo te atenderá lo antes posible…" />
                                <span className="hint">Variables: {'{mention}'}, {'{user}'}, {'{username}'}, {'{number}'}, {'{type}'}. Vacío = mensaje por defecto.</span>
                            </label>
                            <label className="field" style={{ width: 260 }}>Tickets abiertos a la vez por usuario
                                <select value={t.maxOpen} onChange={e => setType(i, { maxOpen: Number(e.target.value) })}>
                                    {[1, 2, 3, 5].map(n => <option key={n} value={n}>{n}</option>)}
                                    <option value={0}>Sin límite</option>
                                </select>
                            </label>

                            <div className="stack" style={{ gap: 8 }}>
                                <div className="row between"><b className="small">Formulario al abrir (opcional)</b><span className="hint">{t.questions.length}/5</span></div>
                                {t.questions.map((qq, n) => (
                                    <div key={n} className="row wrap" style={{ alignItems: 'flex-end' }}>
                                        <label className="field grow" style={{ minWidth: 180 }}>Pregunta<input type="text" maxLength={45} value={qq.label} onChange={e => setQ(i, n, { label: e.target.value })} /></label>
                                        <label className="field grow" style={{ minWidth: 160 }}>Ejemplo<input type="text" maxLength={100} value={qq.placeholder} onChange={e => setQ(i, n, { placeholder: e.target.value })} /></label>
                                        <Check checked={qq.long} onChange={long => setQ(i, n, { long })} label="Larga" />
                                        <Check checked={qq.required} onChange={required => setQ(i, n, { required })} label="Obligatoria" />
                                        <button type="button" className="btn sm ghost icon" onClick={() => setType(i, { questions: t.questions.filter((_, k) => k !== n) })} aria-label="Quitar pregunta"><Icon name="trash" size={14} /></button>
                                    </div>
                                ))}
                                {t.questions.length < 5 && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setType(i, { questions: [...t.questions, { label: '', placeholder: '', long: false, required: true }] })}><Icon name="plus" size={14} /> Añadir pregunta</button>}
                            </div>
                        </>
                    )}
                </div>
            ))}
            {d.types.length < 25 && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setD({ ...d, types: [...d.types, { ...emptyType(), label: '' }] }); setOpen(d.types.length); }}><Icon name="plus" size={14} /> Añadir botón</button>}
        </Modal>
    );
}

function PublishModal({ panel, channels, onClose, onDone }: { panel: TicketPanel; channels: ReturnType<typeof useGuildData>['channels']; onClose: () => void; onDone: () => void }) {
    const [channelId, setChannelId] = useState(panel.channelId ?? '');
    const [saving, setSaving] = useState(false);
    const go2 = async () => {
        if (!channelId) return toast.error('Elige un canal.');
        setSaving(true);
        try { await post(`/tickets/panels/${panel.id}/publish`, { channelId }); onDone(); } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
    };
    return (
        <Modal title={`Publicar · ${panel.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={go2}>Publicar</button></>}>
            <p className="hint" style={{ margin: 0 }}>Se publica un mensaje nuevo con los botones. Si había uno anterior, sus botones siguen funcionando (puedes borrarlo a mano).</p>
            <label className="field">Canal<ChannelSelect value={channelId} channels={channels} onChange={setChannelId} /></label>
        </Modal>
    );
}

function DeletePanelModal({ panel, onClose, onDone }: { panel: TicketPanel; onClose: () => void; onDone: () => void }) {
    const [withMessage, setWithMessage] = useState(true);
    const [saving, setSaving] = useState(false);
    const go2 = async () => {
        setSaving(true);
        try { await del(`/tickets/panels/${panel.id}${withMessage ? '?message=1' : ''}`); onDone(); } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
    };
    return (
        <Modal title="Eliminar panel" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn danger" disabled={saving} onClick={go2}>Eliminar</button></>}>
            <p style={{ margin: 0 }}>Sus botones dejarán de funcionar. Los tickets que ya existen (abiertos y cerrados) se conservan.</p>
            {panel.messageId && <Check checked={withMessage} onChange={setWithMessage} label="Borrar también el mensaje de Discord" />}
        </Modal>
    );
}

// ───────────────────────────── Ajustes ─────────────────────────────

function SettingsPage() {
    const running = useModuleRunning();
    const guild = useGuildData();
    const [cfg, setCfg] = useState<TicketsConfig | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    useEffect(() => { get<TicketsConfig>('/tickets/config').then(setCfg).catch(e => toast.error(errMsg(e))); }, []);
    const set = (patch: Partial<TicketsConfig>) => { setCfg(c => ({ ...c!, ...patch })); setDirty(true); };
    const save = async () => {
        setSaving(true);
        try { setCfg(await put<TicketsConfig>('/tickets/config', cfg)); setDirty(false); toast.ok('Ajustes guardados'); } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
    };

    return (
        <div className="page">
            <PageHead title="Tickets" subtitle="Qué pasa al cerrar un ticket.">
                <button className="btn primary" disabled={!running || saving || !dirty} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
            </PageHead>
            <div style={{ marginBottom: 16 }}><SubNav active="settings" /></div>
            {!cfg ? <Spinner /> : (
                <div className="card stack">
                    <label className="field">Canal de registro
                        <ChannelSelect value={cfg.logChannelId ?? ''} channels={guild.channels} onChange={v => set({ logChannelId: v || null })} />
                        <span className="hint">Al cerrar cada ticket se publica aquí un resumen (y la transcripción). Mejor un canal solo para el staff.</span>
                    </label>
                    <Check checked={cfg.deleteOnClose} onChange={deleteOnClose => set({ deleteOnClose })} label="Borrar el canal al cerrar"
                        hint="Si no, el canal se queda, se renombra a «cerrado-XXXX» y el usuario ya no puede escribir." />
                    {cfg.deleteOnClose && (
                        <label className="field" style={{ width: 260 }}>Esperar antes de borrarlo
                            <select value={cfg.closeDelaySec} onChange={e => set({ closeDelaySec: Number(e.target.value) })}>
                                {[0, 5, 10, 30, 60].map(s => <option key={s} value={s}>{s === 0 ? 'Nada' : `${s} s`}</option>)}
                            </select>
                        </label>
                    )}
                    <Check checked={cfg.dmOnClose} onChange={dmOnClose => set({ dmOnClose })} label="Avisar al usuario por MD al cerrar" hint="Con quién lo cerró y el motivo, si lo hay." />
                    <Check checked={cfg.attachTranscript} onChange={attachTranscript => set({ attachTranscript })} label="Adjuntar la transcripción (HTML) al MD y al registro" />
                </div>
            )}
        </div>
    );
}
