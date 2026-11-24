import { useCallback, useEffect, useRef, useState } from 'react';
import { Bubble } from './Inbox';
import { del, get, post, put, type BanInfo, type LogEvent, type McReport, type Member, type ModAction, type ModCase, type ModerationConfig, type ModuleInfo, type Msg } from '../api';
import { useIsOwner } from '../access';
import { fmtDateTime, fmtDuration, fmtRelative } from '../format';
import { useLive } from '../live';
import { Avatar, Check, ChannelSelect, Empty, Icon, Modal, PageHead, Spinner, UserPicker, errMsg, rememberMember, toast, useConfirm, useGuildData, useMemberLabel } from '../ui';

const ACTION_LABEL: Record<ModAction, string> = {
    warn: 'Aviso', note: 'Nota', timeout: 'Silencio', untimeout: 'Quitar silencio', kick: 'Expulsión', ban: 'Baneo', unban: 'Desbaneo',
};
const ACTION_BADGE: Record<ModAction, string> = {
    warn: 'warn', note: '', timeout: 'warn', untimeout: 'ok', kick: 'danger', ban: 'danger', unban: 'ok',
};
const ACTION_HINT: Record<ModAction, string> = {
    warn: 'Queda en su historial y se le avisa por MD.',
    note: 'Nota interna para el staff: el usuario no se entera.',
    timeout: 'No podrá escribir ni hablar durante el tiempo indicado.',
    untimeout: 'Le quita el silencio antes de tiempo.',
    kick: 'Lo expulsa del servidor; puede volver a entrar con una invitación.',
    ban: 'Lo expulsa y no podrá volver a entrar.',
    unban: 'Le quita el baneo para que pueda volver a entrar.',
};
const DURATIONS: Array<[number, string]> = [[5, '5 min'], [10, '10 min'], [60, '1 h'], [360, '6 h'], [1440, '1 día'], [10080, '1 semana'], [40320, '28 días']];

const LOG_LABEL: Record<LogEvent, string> = {
    messageDelete: 'Mensajes borrados', messageEdit: 'Mensajes editados', memberJoin: 'Entradas al servidor', memberLeave: 'Salidas del servidor',
    roles: 'Cambios de roles', nicknames: 'Cambios de apodo', timeouts: 'Silencios hechos en Discord', bans: 'Baneos hechos en Discord', modActions: 'Acciones del panel y del juego',
    reports: 'Reportes del juego (/report)',
};

type Tab = 'act' | 'history' | 'reports' | 'bans' | 'log';

export default function Moderation() {
    const owner = useIsOwner();
    const [tab, setTab] = useState<Tab>('act');
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    const [userId, setUserId] = useState<string | null>(null);

    useEffect(() => { get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'moderation') ?? null)).catch(() => undefined); }, []);
    useLive(e => { if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'moderation') ?? null); });
    const running = mod?.running ?? true;

    const openUser = (id: string) => { setUserId(id); setTab('act'); };

    return (
        <div className="page">
            <PageHead title="Moderación" subtitle="Sanciona desde el panel, consulta el historial de cada usuario y configura el canal de registro." />
            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Moderación</b> está desactivado: no se registra nada ni se pueden aplicar sanciones. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            <div className="seg" style={{ marginBottom: 16 }} role="tablist">
                {([['act', 'Sancionar'], ['history', 'Historial'], ['reports', 'Reportes del juego'], ['bans', 'Baneados'], ...(owner ? [['log', 'Registro']] : [])] as Array<[Tab, string]>).map(([id, l]) => (
                    <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>
                ))}
            </div>

            {tab === 'act' && <ActTab running={running} userId={userId} setUserId={setUserId} />}
            {tab === 'history' && <HistoryTab onOpenUser={openUser} />}
            {tab === 'reports' && <ReportsTab running={running} onOpenUser={openUser} />}
            {tab === 'bans' && <BansTab running={running} onOpenUser={openUser} />}
            {tab === 'log' && <LogTab running={running} />}
        </div>
    );
}

// ───────────────────────────── Sancionar ─────────────────────────────

function UserName({ id, tag }: { id: string; tag?: string | null }) {
    const label = useMemberLabel(id);
    return <span><b>{label !== id ? label : tag ?? id}</b>{tag && label !== tag && <span className="muted small"> @{tag}</span>}</span>;
}

function ActTab({ running, userId, setUserId }: { running: boolean; userId: string | null; setUserId: (id: string | null) => void }) {
    const confirm = useConfirm();
    const [rawId, setRawId] = useState('');
    const [action, setAction] = useState<ModAction>('warn');
    const [reason, setReason] = useState('');
    const [minutes, setMinutes] = useState(60);
    const [deleteDays, setDeleteDays] = useState(0);
    const [notify, setNotify] = useState(true);
    const [saving, setSaving] = useState(false);
    const [info, setInfo] = useState<{ counts: Partial<Record<ModAction, number>>; cases: ModCase[] } | null>(null);

    const loadUser = useCallback(() => {
        if (!userId) return setInfo(null);
        get<{ counts: Partial<Record<ModAction, number>>; cases: ModCase[] }>(`/moderation/users/${userId}`).then(setInfo).catch(e => toast.error(errMsg(e)));
    }, [userId]);
    useEffect(loadUser, [loadUser]);
    useEffect(() => { get<ModerationConfig>('/moderation/config').then(c => setNotify(c.dmOnAction)).catch(() => undefined); }, []);
    useLive(e => { if (e.type === 'moderation:cases') loadUser(); });

    const needsReason = action !== 'untimeout' && action !== 'unban';
    const canNotify = ['warn', 'timeout', 'kick', 'ban'].includes(action);

    const run = async () => {
        if (!userId) return toast.error('Elige un usuario.');
        if (needsReason && !reason.trim()) return toast.error('Escribe un motivo.');
        if ((action === 'kick' || action === 'ban') && !(await confirm({
            title: action === 'ban' ? 'Banear usuario' : 'Expulsar usuario',
            message: <>¿Seguro que quieres {action === 'ban' ? 'banear' : 'expulsar'} a <UserName id={userId} />?</>,
            confirmLabel: action === 'ban' ? 'Banear' : 'Expulsar', danger: true,
        }))) return;
        setSaving(true);
        try {
            const c = await post<ModCase>('/moderation/actions', {
                action, userId, reason, notify: canNotify ? notify : false,
                durationMs: action === 'timeout' ? minutes * 60_000 : undefined,
                deleteDays: action === 'ban' ? deleteDays : undefined,
            });
            toast.ok(`${ACTION_LABEL[action]} registrado (caso #${c.id})${c.dmStatus === 'failed' ? ' · no se le pudo avisar por MD' : ''}`);
            setReason('');
            loadUser();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <div className="card stack">
                <h2>Usuario</h2>
                {userId ? (
                    <div className="row between">
                        <UserName id={userId} />
                        <button className="btn sm ghost" onClick={() => setUserId(null)}>Cambiar</button>
                    </div>
                ) : (
                    <>
                        <UserPicker onPick={(m: Member) => { rememberMember(m); setUserId(m.id); }} placeholder="Buscar miembro por nombre…" />
                        <div className="row">
                            <input type="text" value={rawId} onChange={e => setRawId(e.target.value.trim())} placeholder="…o pega su ID (también si ya no está en el servidor)" spellCheck={false} />
                            <button className="btn" disabled={!/^\d{17,21}$/.test(rawId)} onClick={() => { setUserId(rawId); setRawId(''); }}>Usar</button>
                        </div>
                    </>
                )}

                <div className="sep" />
                <h2>Sanción</h2>
                <div className="seg">
                    {(Object.keys(ACTION_LABEL) as ModAction[]).map(a => <button key={a} type="button" className={action === a ? 'on' : ''} onClick={() => setAction(a)}>{ACTION_LABEL[a]}</button>)}
                </div>
                <span className="hint" style={{ marginTop: -6 }}>{ACTION_HINT[action]}</span>

                {action === 'timeout' && (
                    <label className="field">Duración
                        <select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
                            {DURATIONS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                        </select>
                    </label>
                )}
                {action === 'ban' && (
                    <label className="field">Borrar sus mensajes de los últimos
                        <select value={deleteDays} onChange={e => setDeleteDays(Number(e.target.value))}>
                            <option value={0}>No borrar nada</option>
                            {[1, 2, 3, 7].map(d => <option key={d} value={d}>{d} {d === 1 ? 'día' : 'días'}</option>)}
                        </select>
                    </label>
                )}
                <label className="field">Motivo{!needsReason && <span className="hint">(opcional)</span>}
                    <textarea rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Se guarda en el historial y aparece en el registro de auditoría de Discord" />
                </label>
                {canNotify && <Check checked={notify} onChange={setNotify} label="Avisarle por MD con el motivo" />}
                <button className={`btn ${action === 'kick' || action === 'ban' ? 'danger' : 'primary'}`} disabled={!running || saving || !userId} onClick={run}>
                    <Icon name="shield" size={16} /> {saving ? 'Aplicando…' : `Aplicar: ${ACTION_LABEL[action]}`}
                </button>
            </div>

            <div className="card stack">
                <h2>Historial del usuario</h2>
                {!userId ? <div className="muted small">Elige un usuario para ver sus avisos y sanciones.</div> : !info ? <Spinner /> : (
                    <>
                        <div className="row wrap" style={{ gap: 6 }}>
                            {(Object.keys(ACTION_LABEL) as ModAction[]).filter(a => info.counts[a]).map(a => (
                                <span key={a} className={`badge ${ACTION_BADGE[a]}`}>{info.counts[a]} × {ACTION_LABEL[a]}</span>
                            ))}
                            {info.cases.length === 0 && <span className="badge ok">Sin sanciones</span>}
                        </div>
                        <CaseList cases={info.cases} showUser={false} onChanged={loadUser} />
                    </>
                )}
            </div>
        </div>
    );
}

function CaseList({ cases, showUser, onChanged, onOpenUser }: { cases: ModCase[]; showUser: boolean; onChanged: () => void; onOpenUser?: (id: string) => void }) {
    const confirm = useConfirm();
    const owner = useIsOwner();
    const remove = async (c: ModCase) => {
        if (!(await confirm({ title: `Borrar caso #${c.id}`, message: 'Solo se borra del historial del panel; no deshace la sanción en Discord.', confirmLabel: 'Borrar', danger: true }))) return;
        try { await del(`/moderation/cases/${c.id}`); onChanged(); } catch (e) { toast.error(errMsg(e)); }
    };
    if (!cases.length) return <Empty title="Sin casos">No hay nada registrado.</Empty>;
    return (
        <div className="table-wrap">
            <table>
                <thead><tr><th>#</th>{showUser && <th>Usuario</th>}<th>Acción</th><th>Motivo</th><th>Moderador</th><th>Fecha</th><th /></tr></thead>
                <tbody>
                    {cases.map(c => (
                        <tr key={c.id}>
                            <td className="muted small">{c.id}</td>
                            {showUser && <td>{onOpenUser ? <button className="btn ghost sm" onClick={() => onOpenUser(c.userId)}><UserName id={c.userId} tag={c.userTag} /></button> : <UserName id={c.userId} tag={c.userTag} />}</td>}
                            <td>
                                <span className={`badge ${ACTION_BADGE[c.action]}`}>{ACTION_LABEL[c.action]}</span>
                                {c.durationMs && <div className="muted small">{fmtDuration(c.durationMs)}</div>}
                                {c.expiresAt && <div className="muted small" title={fmtDateTime(c.expiresAt)}>hasta {fmtDateTime(c.expiresAt)}</div>}
                                {c.mcName && <div className="muted small" title="Cuenta de Minecraft">⛏ {c.mcName}</div>}
                            </td>
                            <td className="small" style={{ maxWidth: 320 }}>
                                {c.reason ?? <span className="muted">—</span>}
                                {c.dmStatus === 'failed' && <div className="small" style={{ color: 'var(--warn)' }}>No se le pudo avisar por MD</div>}
                            </td>
                            <td className="small">
                                {c.source === 'discord' ? <span className="muted" title="Se hizo directamente en Discord">En Discord</span> : c.moderatorName}
                                {c.source === 'minecraft' && <div><span className="badge" title="Se hizo en el servidor de Minecraft">Minecraft</span></div>}
                            </td>
                            <td className="small muted" title={fmtDateTime(c.createdAt)}>{fmtRelative(c.createdAt)}</td>
                            <td>{owner && <button className="btn sm ghost icon" onClick={() => remove(c)} aria-label={`Borrar caso ${c.id}`}><Icon name="trash" size={14} /></button>}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ───────────────────────────── Historial global ─────────────────────────────

function HistoryTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
    const [action, setAction] = useState<ModAction | ''>('');
    const [cases, setCases] = useState<ModCase[] | null>(null);
    const load = useCallback(() => {
        get<ModCase[]>(`/moderation/cases?limit=200${action ? `&action=${action}` : ''}`).then(setCases).catch(e => toast.error(errMsg(e)));
    }, [action]);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'moderation:cases') load(); });

    return (
        <div className="card stack">
            <div className="row between wrap">
                <h2>Últimos casos</h2>
                <select style={{ width: 'auto' }} value={action} onChange={e => setAction(e.target.value as ModAction | '')}>
                    <option value="">Todas las acciones</option>
                    {(Object.keys(ACTION_LABEL) as ModAction[]).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                </select>
            </div>
            {!cases ? <Spinner /> : <CaseList cases={cases} showUser onChanged={load} onOpenUser={onOpenUser} />}
        </div>
    );
}

// ───────────────────────────── Reportes del juego ─────────────────────────────

function ReportsTab({ running, onOpenUser }: { running: boolean; onOpenUser: (id: string) => void }) {
    const [open, setOpen] = useState(true);
    const [reports, setReports] = useState<McReport[] | null>(null);
    const [chat, setChat] = useState<McReport | null>(null);
    const load = useCallback(() => {
        get<McReport[]>(`/moderation/reports?open=${open ? 1 : 0}&limit=200`).then(setReports).catch(e => { toast.error(errMsg(e)); setReports([]); });
    }, [open]);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'moderation:reports') load(); });

    const close = async (r: McReport) => {
        try { await post(`/moderation/reports/${r.id}/close`, {}); toast.ok(`Reporte #${r.id} cerrado (también en el juego)`); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    return (
        <div className="card stack">
            <div className="row between wrap">
                <div><h2>Reportes del juego</h2><div className="hint">Lo que los jugadores envían con <code>/report</code> en el servidor de Minecraft. Al cerrarlo aquí se cierra también en el juego.</div></div>
                <div className="seg" role="tablist">
                    <button type="button" className={open ? 'on' : ''} onClick={() => setOpen(true)}>Abiertos</button>
                    <button type="button" className={!open ? 'on' : ''} onClick={() => setOpen(false)}>Cerrados</button>
                </div>
            </div>
            {!reports ? <Spinner /> : reports.length === 0 ? <Empty title={open ? 'No hay reportes abiertos' : 'No hay reportes cerrados'}>{open ? 'Todo en orden.' : ''}</Empty> : (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>#</th><th>Reportado</th><th>Motivo</th><th>Por</th><th>Fecha</th><th /></tr></thead>
                        <tbody>
                            {reports.map(r => (
                                <tr key={r.id}>
                                    <td className="muted small">{r.id}</td>
                                    <td>
                                        {r.targetDiscordId
                                            ? <button className="btn ghost sm" title="Ver su historial y sancionar" onClick={() => onOpenUser(r.targetDiscordId!)}><b>{r.targetName}</b> <UserName id={r.targetDiscordId} /></button>
                                            : <b>{r.targetName}</b>}
                                        {!r.targetDiscordId && <div className="muted small">Sin Discord vinculado</div>}
                                    </td>
                                    <td className="small" style={{ maxWidth: 340 }}>
                                        {r.reason}
                                        {r.location && <div className="muted small">📍 {r.location}</div>}
                                    </td>
                                    <td className="small">
                                        {r.reporterName}
                                        {r.reporterDiscordId && <div className="muted small"><UserName id={r.reporterDiscordId} /></div>}
                                        {r.dmStatus === 'failed' && <div className="small" style={{ color: 'var(--warn)' }}>No se le pudo escribir por MD</div>}
                                    </td>
                                    <td className="small muted" title={fmtDateTime(r.createdAt)}>
                                        {fmtRelative(r.createdAt)}
                                        {r.closedAt && <div>Cerrado por {r.closedBy ?? '—'}</div>}
                                    </td>
                                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                        {r.reporterDiscordId
                                            ? <button className="btn sm ghost" title="Hablar por MD con quien hizo el reporte" onClick={() => setChat(r)}><Icon name="inbox" size={14} /> Conversación</button>
                                            : <span className="muted small" title="Quien reportó no tiene Discord vinculado">Sin MD</span>}
                                        {' '}{!r.closedAt && <button className="btn sm" disabled={!running} onClick={() => close(r)}>Cerrar</button>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {chat && <ReportChat report={chat} onClose={() => setChat(null)} />}
        </div>
    );
}

/** Conversación por MD con quien hizo un reporte: la misma que en la bandeja, sin salir de la moderación. */
function ReportChat({ report, onClose }: { report: McReport; onClose: () => void }) {
    const userId = report.reporterDiscordId!;
    const [thread, setThread] = useState<Msg[] | null>(null);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const bottom = useRef<HTMLDivElement>(null);

    useEffect(() => {
        get<Msg[]>(`/inbox/conversations/${userId}`).then(m => { setThread(m); post(`/inbox/conversations/${userId}/read`).catch(() => undefined); })
            .catch(e => { toast.error(errMsg(e)); setThread([]); });
    }, [userId]);
    useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [thread]);
    useLive(e => {
        if (e.type !== 'message:new') return;
        const m = e.data as Msg;
        if (m.kind !== 'dm' || m.userId !== userId) return;
        setThread(t => (t ?? []).some(x => x.id === m.id) ? t : [...(t ?? []), m]);
        if (m.direction === 'in') post(`/inbox/conversations/${userId}/read`).catch(() => undefined);
    });

    const send = async () => {
        if (!text.trim()) return;
        setSending(true);
        try {
            const m = await post<Msg>(`/inbox/conversations/${userId}/reply`, { content: text.trim() });
            setThread(t => (t ?? []).some(x => x.id === m.id) ? t : [...(t ?? []), m]);
            setText('');
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSending(false); }
    };

    return (
        <Modal title={`Reporte #${report.id} · conversación con ${report.reporterName}`} onClose={onClose} wide footer={
            <div className="row" style={{ width: '100%', gap: 8 }}>
                <input style={{ flex: 1 }} value={text} maxLength={2000} placeholder={`Escribe a ${report.reporterName} por MD…`}
                    onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <button className="btn primary" disabled={sending || !text.trim()} onClick={send}>{sending ? 'Enviando…' : 'Enviar'}</button>
            </div>
        }>
            <div className="small muted" style={{ marginBottom: 8 }}>
                Sobre <b>{report.targetName}</b>: {report.reason}. Lo que contestes le llega por MD; sus respuestas aparecen aquí y en la Bandeja.
            </div>
            <div className="thread" style={{ maxHeight: 380, overflowY: 'auto' }}>
                {!thread ? <Spinner /> : thread.length === 0 ? <Empty title="Aún no hay mensajes" /> : thread.map(m => <Bubble key={m.id} m={m} />)}
                <div ref={bottom} />
            </div>
        </Modal>
    );
}

// ───────────────────────────── Baneados ─────────────────────────────

function BansTab({ running, onOpenUser }: { running: boolean; onOpenUser: (id: string) => void }) {
    const confirm = useConfirm();
    const [bans, setBans] = useState<BanInfo[] | null>(null);
    const [q, setQ] = useState('');
    const load = useCallback(() => { get<BanInfo[]>('/moderation/bans').then(setBans).catch(e => { toast.error(errMsg(e)); setBans([]); }); }, []);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'moderation:cases' && (e.data?.action === 'ban' || e.data?.action === 'unban')) load(); });

    const unban = async (b: BanInfo) => {
        if (!(await confirm({ title: 'Desbanear', message: <>¿Quitar el baneo a <b>{b.username}</b>? Podrá volver a entrar con una invitación.</>, confirmLabel: 'Desbanear' }))) return;
        try { await post('/moderation/actions', { action: 'unban', userId: b.userId, reason: '' }); toast.ok('Desbaneado'); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    const list = (bans ?? []).filter(b => !q || b.username.toLowerCase().includes(q.toLowerCase()) || b.userId === q);
    return (
        <div className="card stack">
            <div className="row between wrap">
                <h2>Baneados {bans && <span className="muted">({bans.length})</span>}</h2>
                <input type="search" style={{ width: 240 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar…" />
            </div>
            {!bans ? <Spinner /> : list.length === 0 ? <Empty title="No hay nadie baneado" /> : (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Usuario</th><th>Motivo</th><th /></tr></thead>
                        <tbody>
                            {list.map(b => (
                                <tr key={b.userId}>
                                    <td><button className="btn ghost sm" onClick={() => onOpenUser(b.userId)}><Avatar src={b.avatar} name={b.username} size="sm" /> {b.username}</button></td>
                                    <td className="small">{b.reason ?? <span className="muted">—</span>}</td>
                                    <td style={{ textAlign: 'right' }}><button className="btn sm" disabled={!running} onClick={() => unban(b)}>Desbanear</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

// ───────────────────────────── Registro ─────────────────────────────

function LogTab({ running }: { running: boolean }) {
    const guild = useGuildData();
    const [cfg, setCfg] = useState<ModerationConfig | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    useEffect(() => { get<ModerationConfig>('/moderation/config').then(setCfg).catch(e => toast.error(errMsg(e))); }, []);
    if (!cfg) return <Spinner />;
    const set = (patch: Partial<ModerationConfig>) => { setCfg({ ...cfg, ...patch }); setDirty(true); };
    const toggleIgnored = (id: string) => set({ ignoreChannelIds: cfg.ignoreChannelIds.includes(id) ? cfg.ignoreChannelIds.filter(x => x !== id) : [...cfg.ignoreChannelIds, id] });

    const save = async () => {
        setSaving(true);
        try { setCfg(await put<ModerationConfig>('/moderation/config', cfg)); setDirty(false); toast.ok('Registro guardado'); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <div className="card stack">
            <div className="row between wrap">
                <div><h2>Canal de registro</h2><div className="hint">Todo lo que marques se publica en este canal. Mejor uno privado, solo para el staff.</div></div>
                <button className="btn primary" disabled={!running || saving || !dirty} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
            </div>
            <label className="field">Canal<ChannelSelect value={cfg.logChannelId ?? ''} channels={guild.channels} onChange={v => set({ logChannelId: v || null })} /></label>
            {!cfg.logChannelId && <div className="alert info">Sin canal elegido no se publica nada (las sanciones se siguen guardando en el historial).</div>}

            <div className="grid cols-2">
                {(Object.keys(LOG_LABEL) as LogEvent[]).map(e => (
                    <Check key={e} checked={cfg.log[e]} onChange={v => set({ log: { ...cfg.log, [e]: v } })} label={LOG_LABEL[e]} />
                ))}
            </div>

            <div className="sep" />
            <Check checked={cfg.dmOnAction} onChange={dmOnAction => set({ dmOnAction })} label="Por defecto, avisar por MD al sancionar" hint="Se puede cambiar en cada sanción." />

            <div className="field">
                <span>No registrar mensajes borrados/editados en estos canales</span>
                <div className="card" style={{ background: 'var(--panel-2)', padding: 10, maxHeight: 160, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 6 }}>
                    {guild.channels.map(c => (
                        <label key={c.id} className="check" style={{ fontWeight: 450 }}><input type="checkbox" checked={cfg.ignoreChannelIds.includes(c.id)} onChange={() => toggleIgnored(c.id)} /> #{c.name}</label>
                    ))}
                </div>
            </div>
        </div>
    );
}
