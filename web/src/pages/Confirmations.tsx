import { useCallback, useEffect, useMemo, useState } from 'react';
import { del, get, post, put, type Campaign, type Entry, type Member } from '../api';
import { fmtDateTime, fmtRelative } from '../format';
import { useLive } from '../live';
import {
    Avatar, Check, ChannelSelect, Empty, Icon, Modal, PageHead, RoleSelect, Spinner, Switch, UserPicker,
    errMsg, toast, useConfirm, useGuildData,
} from '../ui';

interface Stats { confirmed: number; denied: number; pending: number; members: number; roleMembers: number }
interface Progress { total: number; done: number; failed: number; finished: boolean }

const blank = (): Omit<Campaign, 'id' | 'legacy' | 'counterChannelId' | 'counterMessageId'> => ({
    name: '', enabled: true, title: '✨ Confirmación de Participación',
    description: 'Hola {user}, para participar completa el formulario con el botón de abajo.',
    color: '#3B82F6', confirmLabel: 'Abrir formulario', denyLabel: 'No deseo participar', inputLabel: 'Escribe tu nombre de usuario',
    allowDeny: true, confirmedRoleId: null, deniedRoleId: null, excludeRoleIds: [], skipResponded: true, sendOnJoin: false,
    setNickname: false, nicknameTemplate: '{global} ({answer})', counterTitle: '📊 Cantidad de Personas QUE HAN CONFIRMADO:',
});

export default function Confirmations() {
    const confirm = useConfirm();
    const guild = useGuildData();
    const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
    const [sel, setSel] = useState<number | null>(null);
    const [entries, setEntries] = useState<Entry[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [filter, setFilter] = useState<'all' | 'confirmed' | 'denied'>('all');
    const [q, setQ] = useState('');
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [modal, setModal] = useState<null | 'edit' | 'new' | 'add' | 'send' | 'counter' | 'delete'>(null);
    const [deleteIds, setDeleteIds] = useState<string[]>([]);
    const [progress, setProgress] = useState<Progress | null>(null);

    const campaign = campaigns?.find(c => c.id === sel) ?? null;

    const loadCampaigns = useCallback(() => {
        get<Campaign[]>('/confirmations/campaigns').then(c => { setCampaigns(c); setSel(s => (s && c.some(x => x.id === s)) ? s : (c[0]?.id ?? null)); }).catch(e => toast.error(errMsg(e)));
    }, []);
    const loadData = useCallback(() => {
        if (!sel) return;
        Promise.all([get<Entry[]>(`/confirmations/campaigns/${sel}/entries`), get<Stats>(`/confirmations/campaigns/${sel}/stats`)])
            .then(([e, s]) => { setEntries(e); setStats(s); }).catch(e => toast.error(errMsg(e)));
    }, [sel]);

    useEffect(loadCampaigns, [loadCampaigns]);
    useEffect(() => { setEntries([]); setStats(null); setChecked(new Set()); setProgress(null); loadData(); }, [loadData]);
    useLive(e => {
        if (e.type === 'confirmations:changed' && e.data?.campaignId === sel) loadData();
        else if (e.type === 'campaign:updated' || e.type === 'campaign:deleted') loadCampaigns();
        else if (e.type === 'bulk:progress' && e.data?.batchId === `campaign-${sel}`) {
            setProgress(e.data as Progress);
            if (e.data.finished) { loadData(); toast.ok(`Formularios enviados: ${e.data.total - e.data.failed} correctos${e.data.failed ? `, ${e.data.failed} fallidos` : ''}.`); }
        }
    });

    const visible = useMemo(() => entries.filter(e =>
        (filter === 'all' || e.status === filter) &&
        (!q || [e.username, e.displayName, e.answer, e.reason].some(v => v?.toLowerCase().includes(q.toLowerCase())))
    ), [entries, filter, q]);

    const allChecked = visible.length > 0 && visible.every(e => checked.has(e.userId));
    const toggleAll = () => setChecked(allChecked ? new Set() : new Set(visible.map(e => e.userId)));
    const toggleOne = (id: string) => setChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    const sendPending = async () => {
        if (!campaign || !stats) return;
        if (!(await confirm({ title: 'Enviar formulario', message: <>Se enviará el formulario de <b>{campaign.name}</b> por MD a <b>{stats.pending}</b> miembros pendientes (uno por segundo aprox.).</>, confirmLabel: 'Enviar' }))) return;
        try { await post(`/confirmations/campaigns/${campaign.id}/send`, {}); setProgress({ total: stats.pending, done: 0, failed: 0, finished: false }); }
        catch (e) { toast.error(errMsg(e)); }
    };

    const refreshCounter = async () => {
        if (!campaign) return;
        try { await post(`/confirmations/campaigns/${campaign.id}/refresh`); toast.ok('Contador actualizado'); } catch (e) { toast.error(errMsg(e)); }
    };

    const toggleEnabled = async (c: Campaign, enabled: boolean) => {
        try { await put(`/confirmations/campaigns/${c.id}`, { ...c, enabled }); loadCampaigns(); } catch (e) { toast.error(errMsg(e)); }
    };

    const deleteCampaign = async () => {
        if (!campaign) return;
        if (!(await confirm({ title: 'Eliminar campaña', message: <>Se eliminará <b>{campaign.name}</b> y todos sus confirmados registrados ({entries.length}). Los roles y apodos en Discord no se tocan. No se puede deshacer.</>, confirmLabel: 'Eliminar', danger: true }))) return;
        try { await del(`/confirmations/campaigns/${campaign.id}`); toast.ok('Campaña eliminada'); setSel(null); loadCampaigns(); } catch (e) { toast.error(errMsg(e)); }
    };

    const resend = async (e: Entry) => {
        if (!campaign) return;
        try { await post(`/confirmations/campaigns/${campaign.id}/send`, { userIds: [e.userId] }); toast.ok(`Formulario reenviado a ${e.username ?? e.userId}`); } catch (err) { toast.error(errMsg(err)); }
    };

    const roleName = (id: string | null) => guild.roles.find(r => r.id === id)?.name;
    const channelName = (id: string | null) => guild.channels.find(c => c.id === id)?.name;

    if (!campaigns) return <div className="page"><Spinner /></div>;

    return (
        <div className="page">
            <PageHead title="Confirmaciones" subtitle="Varias campañas a la vez: cada una con su formulario, roles, contador y lista de confirmados.">
                <button className="btn primary" onClick={() => setModal('new')}><Icon name="plus" /> Nueva campaña</button>
            </PageHead>

            {campaigns.length === 0 ? <div className="card"><Empty title="Aún no hay campañas">Crea una para pedir confirmación a los miembros.</Empty></div> : (
                <>
                    <div className="seg" style={{ marginBottom: 16 }}>
                        {campaigns.map(c => <button key={c.id} className={sel === c.id ? 'on' : ''} onClick={() => setSel(c.id)}>{c.name}{!c.enabled && ' ⏸'}</button>)}
                    </div>

                    {campaign && (
                        <div className="stack">
                            <div className="card stack">
                                <div className="row between wrap">
                                    <div className="row"><h2>{campaign.name}</h2>{campaign.legacy && <span className="badge" title="Campaña importada de la configuración anterior del bot">Importada</span>}</div>
                                    <div className="row wrap">
                                        <label className="row small muted">Activa <Switch checked={campaign.enabled} onChange={v => toggleEnabled(campaign, v)} label="Campaña activa" /></label>
                                        <button className="btn sm" onClick={() => setModal('edit')}><Icon name="edit" size={14} /> Editar</button>
                                        <button className="btn sm danger" onClick={deleteCampaign} aria-label="Eliminar campaña"><Icon name="trash" size={14} /></button>
                                    </div>
                                </div>

                                <div className="grid tiles">
                                    <div className="tile"><div className="label">Confirmados</div><div className="value" style={{ color: 'var(--ok)' }}>{stats?.confirmed ?? '…'}</div></div>
                                    <div className="tile"><div className="label">No participan</div><div className="value" style={{ color: 'var(--danger)' }}>{stats?.denied ?? '…'}</div></div>
                                    <div className="tile"><div className="label">Pendientes de recibir</div><div className="value">{stats?.pending ?? '…'}</div></div>
                                    <div className="tile" title={roleName(campaign.confirmedRoleId) ? `Miembros con el rol "${roleName(campaign.confirmedRoleId)}"` : undefined}><div className="label">Con el rol</div><div className="value">{campaign.confirmedRoleId ? (stats?.roleMembers ?? '…') : '—'}</div></div>
                                </div>

                                {progress && !progress.finished && (
                                    <div><div className="row between small muted"><span>Enviando formularios…</span><span>{progress.done}/{progress.total}</span></div>
                                        <div className="progress"><div style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} /></div></div>
                                )}

                                <div className="row wrap">
                                    <button className="btn primary" disabled={!campaign.enabled || !stats?.pending} onClick={sendPending}><Icon name="send" /> Enviar a pendientes{stats ? ` (${stats.pending})` : ''}</button>
                                    <button className="btn" disabled={!campaign.enabled} onClick={() => setModal('send')}>Enviar a usuarios concretos…</button>
                                    <button className="btn" onClick={() => setModal('add')}><Icon name="plus" size={14} /> Añadir confirmado a mano</button>
                                </div>
                                {!campaign.confirmedRoleId && <div className="alert">Esta campaña no tiene rol de confirmado: se guardarán las respuestas pero no se dará ningún rol ni funcionará el contador.</div>}

                                <div className="sep" />
                                <div className="row between wrap">
                                    <div>
                                        <b>Mensaje contador</b>
                                        <div className="muted small">{campaign.counterMessageId ? <>Se actualiza solo en <b>#{channelName(campaign.counterChannelId) ?? campaign.counterChannelId}</b> cada vez que alguien cambia de rol, entra o sale.</> : 'Un mensaje fijo en un canal que muestra cuántos han confirmado y quiénes.'}</div>
                                    </div>
                                    <div className="row">
                                        {campaign.counterMessageId && <button className="btn sm" onClick={refreshCounter}><Icon name="refresh" size={14} /> Actualizar ahora</button>}
                                        <button className="btn sm" disabled={!campaign.confirmedRoleId} onClick={() => setModal('counter')}>{campaign.counterMessageId ? 'Crear en otro canal' : 'Crear mensaje contador'}</button>
                                    </div>
                                </div>
                            </div>

                            <div className="card tight">
                                <div className="row wrap" style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
                                    <div className="seg">
                                        {([['all', 'Todos'], ['confirmed', 'Confirmados'], ['denied', 'No participan']] as const).map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}
                                    </div>
                                    <input type="search" style={{ maxWidth: 260 }} placeholder="Buscar…" value={q} onChange={e => setQ(e.target.value)} />
                                    <div className="grow" />
                                    {checked.size > 0 && <button className="btn danger" onClick={() => { setDeleteIds([...checked]); setModal('delete'); }}><Icon name="trash" size={14} /> Borrar seleccionados ({checked.size})</button>}
                                </div>
                                {visible.length === 0 ? <Empty title="Sin resultados">{entries.length === 0 ? 'Nadie ha respondido todavía.' : 'Prueba con otro filtro.'}</Empty> : (
                                    <div className="table-wrap"><table>
                                        <thead><tr>
                                            <th className="shrink"><input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Seleccionar todos" /></th>
                                            <th>Usuario</th><th>Respuesta</th><th>Estado</th><th>Fecha</th><th /></tr></thead>
                                        <tbody>
                                            {visible.map(e => (
                                                <tr key={e.id} className={checked.has(e.userId) ? 'sel' : ''}>
                                                    <td className="shrink"><input type="checkbox" checked={checked.has(e.userId)} onChange={() => toggleOne(e.userId)} aria-label={`Seleccionar ${e.username}`} /></td>
                                                    <td><b>{e.displayName ?? e.username ?? e.userId}</b>{e.username && <span className="muted"> @{e.username}</span>}
                                                        <div className="row small" style={{ gap: 6, marginTop: 2 }}>
                                                            {e.unresolved && <span className="badge warn" title="Importado sin ID de Discord y esa persona no está en el servidor">No encontrado</span>}
                                                            {!e.unresolved && !e.inGuild && <span className="badge warn">Ya no está en el servidor</span>}
                                                            {e.status === 'confirmed' && campaign.confirmedRoleId && e.inGuild && !e.hasRole && <span className="badge warn" title="Confirmó pero no tiene el rol ahora">Sin rol</span>}
                                                        </div></td>
                                                    <td style={{ maxWidth: 320 }}><span className="ellipsis" style={{ display: 'block' }} title={e.answer ?? e.reason ?? ''}>{e.status === 'confirmed' ? (e.answer ?? '—') : (e.reason ?? '—')}</span></td>
                                                    <td className="shrink">{e.status === 'confirmed' ? <span className="badge ok">Confirmado</span> : <span className="badge danger">No participa</span>}</td>
                                                    <td className="shrink muted small" title={fmtDateTime(e.updatedAt)}>{fmtRelative(e.updatedAt)}</td>
                                                    <td className="shrink">
                                                        <div className="row" style={{ gap: 4 }}>
                                                            {!e.unresolved && <button className="btn sm ghost" title="Reenviar el formulario" onClick={() => resend(e)} disabled={!campaign.enabled}><Icon name="send" size={14} /></button>}
                                                            <button className="btn sm ghost" title="Borrar" onClick={() => { setDeleteIds([e.userId]); setModal('delete'); }}><Icon name="trash" size={14} /></button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table></div>
                                )}
                            </div>
                        </div>
                    )}
                </>
            )}

            {(modal === 'edit' || modal === 'new') && (
                <CampaignEditor initial={modal === 'edit' ? campaign : null} guild={guild} onClose={() => setModal(null)}
                    onSaved={c => { setModal(null); setSel(c.id); loadCampaigns(); loadData(); }} />
            )}
            {modal === 'add' && campaign && <AddEntryModal campaign={campaign} onClose={() => setModal(null)} onDone={() => { setModal(null); loadData(); }} />}
            {modal === 'send' && campaign && <SendToModal campaign={campaign} onClose={() => setModal(null)} onDone={() => setModal(null)} />}
            {modal === 'counter' && campaign && <CounterModal campaign={campaign} channels={guild.channels} onClose={() => setModal(null)} onDone={() => { setModal(null); loadCampaigns(); }} />}
            {modal === 'delete' && campaign && (
                <DeleteModal campaign={campaign} ids={deleteIds} entries={entries} onClose={() => setModal(null)}
                    onDone={() => { setModal(null); setChecked(new Set()); loadData(); }} />
            )}
        </div>
    );
}

// ───────────────────────────── Modales ─────────────────────────────

function CampaignEditor({ initial, guild, onClose, onSaved }: {
    initial: Campaign | null; guild: ReturnType<typeof useGuildData>; onClose: () => void; onSaved: (c: Campaign) => void;
}) {
    const [d, setD] = useState(() => initial ? { ...initial } : blank());
    const [saving, setSaving] = useState(false);
    const set = (patch: Partial<typeof d>) => setD(x => ({ ...x, ...patch }));

    const save = async () => {
        if (!d.name.trim() || !d.title.trim() || !d.description.trim()) return toast.error('Nombre, título y descripción son obligatorios.');
        setSaving(true);
        try {
            const saved = initial ? await put<Campaign>(`/confirmations/campaigns/${initial.id}`, d) : await post<Campaign>('/confirmations/campaigns', d);
            toast.ok(initial ? 'Campaña guardada' : 'Campaña creada');
            onSaved(saved);
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    const toggleExclude = (id: string) => set({ excludeRoleIds: d.excludeRoleIds.includes(id) ? d.excludeRoleIds.filter(x => x !== id) : [...d.excludeRoleIds, id] });

    return (
        <Modal title={initial ? `Editar "${initial.name}"` : 'Nueva campaña'} wide onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </>}>
            <label className="field">Nombre interno<input type="text" maxLength={80} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="Confirmación Hytale" /></label>

            <div className="stack" style={{ gap: 10 }}>
                <h3>Mensaje que reciben por MD</h3>
                <div className="row">
                    <label className="field grow">Título<input type="text" maxLength={256} value={d.title} onChange={e => set({ title: e.target.value })} /></label>
                    <label className="field">Color<input type="color" value={d.color} onChange={e => set({ color: e.target.value.toUpperCase() })} /></label>
                </div>
                <label className="field">Descripción<textarea rows={4} maxLength={4000} value={d.description} onChange={e => set({ description: e.target.value })} /><span className="hint">Admite Markdown de Discord y las variables {'{user}'}, {'{username}'}, {'{server}'}.</span></label>
                <div className="grid cols-3">
                    <label className="field">Botón de confirmar<input type="text" maxLength={80} value={d.confirmLabel} onChange={e => set({ confirmLabel: e.target.value })} /></label>
                    <label className="field">Botón de rechazar<input type="text" maxLength={80} value={d.denyLabel} disabled={!d.allowDeny} onChange={e => set({ denyLabel: e.target.value })} /></label>
                    <label className="field">Pregunta del formulario<input type="text" maxLength={45} value={d.inputLabel} onChange={e => set({ inputLabel: e.target.value })} /></label>
                </div>
                <Check checked={d.allowDeny} onChange={allowDeny => set({ allowDeny })} label='Mostrar botón "No deseo participar"' />
                <div className="dc" style={{ marginTop: 4 }}>
                    <div className="dc-embed" style={{ marginLeft: 0, borderLeftColor: d.color }}>
                        <div className="t">{d.title}</div><div className="d">{d.description}</div>
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                        <span className="badge" style={{ background: '#4e5058', color: '#fff', padding: '6px 12px' }}>📝 {d.confirmLabel}</span>
                        {d.allowDeny && <span className="badge" style={{ background: '#da373c', color: '#fff', padding: '6px 12px' }}>❌ {d.denyLabel}</span>}
                    </div>
                </div>
            </div>

            <div className="sep" />
            <div className="stack" style={{ gap: 10 }}>
                <h3>Roles</h3>
                <div className="grid cols-2">
                    <label className="field">Rol que se da al confirmar<RoleSelect value={d.confirmedRoleId} onChange={confirmedRoleId => set({ confirmedRoleId })} roles={guild.roles} /></label>
                    <label className="field">Rol que se da al rechazar<RoleSelect value={d.deniedRoleId} onChange={deniedRoleId => set({ deniedRoleId })} roles={guild.roles} /></label>
                </div>
                <div className="field">
                    <span>No enviar a quien tenga alguno de estos roles</span>
                    <div className="card" style={{ background: 'var(--panel-2)', padding: 10, maxHeight: 150, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 6 }}>
                        {guild.roles.filter(r => !r.managed).map(r => (
                            <label key={r.id} className="check" style={{ fontWeight: 450 }}><input type="checkbox" checked={d.excludeRoleIds.includes(r.id)} onChange={() => toggleExclude(r.id)} /> {r.name}</label>
                        ))}
                        {guild.roles.length === 0 && <span className="hint">Cargando roles…</span>}
                    </div>
                </div>
            </div>

            <div className="sep" />
            <div className="stack" style={{ gap: 10 }}>
                <h3>Comportamiento</h3>
                <Check checked={d.skipResponded} onChange={skipResponded => set({ skipResponded })} label="No volver a enviar a quien ya respondió" hint="Evita reenviar el formulario a confirmados y rechazados en cada envío programado." />
                <Check checked={d.sendOnJoin} onChange={sendOnJoin => set({ sendOnJoin })} label="Enviar automáticamente a los miembros nuevos al unirse" />
                <Check checked={d.setNickname} onChange={setNickname => set({ setNickname })} label="Cambiar el apodo del usuario al confirmar" />
                {d.setNickname && (
                    <label className="field" style={{ maxWidth: 360 }}>Plantilla del apodo
                        <input type="text" maxLength={64} value={d.nicknameTemplate} onChange={e => set({ nicknameTemplate: e.target.value })} />
                        <span className="hint">Variables: {'{global}'} (nombre visible), {'{username}'}, {'{answer}'} (lo que escribe). Máx. 32 caracteres en Discord.</span>
                    </label>
                )}
                <label className="field">Título del mensaje contador<input type="text" maxLength={256} value={d.counterTitle} onChange={e => set({ counterTitle: e.target.value })} /></label>
            </div>
        </Modal>
    );
}

function AddEntryModal({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: () => void }) {
    const [user, setUser] = useState<Member | null>(null);
    const [status, setStatus] = useState<'confirmed' | 'denied'>('confirmed');
    const [text, setText] = useState('');
    const [applyRoles, setApplyRoles] = useState(true);
    const [saving, setSaving] = useState(false);

    const save = async () => {
        if (!user) return toast.error('Elige un usuario.');
        setSaving(true);
        try {
            const r = await post<{ warnings: string[] }>(`/confirmations/campaigns/${campaign.id}/entries`, { userId: user.id, status, answer: status === 'confirmed' ? text : '', reason: status === 'denied' ? text : '', applyRoles });
            toast.ok('Guardado');
            r.warnings.forEach(w => toast.info(w));
            onDone();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal title="Añadir o corregir una respuesta" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={save}>Guardar</button></>}>
            {user ? <div><span className="chip"><Avatar src={user.avatar} name={user.displayName} size="sm" />{user.displayName}<button onClick={() => setUser(null)} aria-label="Quitar">×</button></span></div> : <UserPicker onPick={setUser} />}
            <div className="seg"><button className={status === 'confirmed' ? 'on' : ''} onClick={() => setStatus('confirmed')}>Confirmado</button><button className={status === 'denied' ? 'on' : ''} onClick={() => setStatus('denied')}>No participa</button></div>
            <label className="field">{status === 'confirmed' ? campaign.inputLabel : 'Motivo'}<input type="text" value={text} maxLength={status === 'confirmed' ? 100 : 1000} onChange={e => setText(e.target.value)} /></label>
            <Check checked={applyRoles} onChange={setApplyRoles} label="Aplicar roles (y apodo) en Discord" hint="Si ya la tiene en Discord y solo quieres registrarla, desmárcalo." />
            <p className="hint" style={{ margin: 0 }}>Si el usuario ya tenía una respuesta, se sustituye.</p>
        </Modal>
    );
}

function SendToModal({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: () => void }) {
    const [users, setUsers] = useState<Member[]>([]);
    const [sending, setSending] = useState(false);
    const send = async () => {
        if (!users.length) return toast.error('Elige al menos un usuario.');
        setSending(true);
        try { await post(`/confirmations/campaigns/${campaign.id}/send`, { userIds: users.map(u => u.id) }); toast.ok('Enviando formulario…'); onDone(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSending(false); }
    };
    return (
        <Modal title="Enviar formulario a usuarios concretos" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={sending} onClick={send}>Enviar</button></>}>
            <p className="hint" style={{ margin: 0 }}>Se envía aunque ya hayan respondido o tengan un rol excluido.</p>
            <div className="row wrap">{users.map(u => <span className="chip" key={u.id}>{u.displayName}<button onClick={() => setUsers(x => x.filter(y => y.id !== u.id))} aria-label="Quitar">×</button></span>)}</div>
            <UserPicker exclude={users.map(u => u.id)} onPick={u => setUsers(x => [...x, u])} placeholder="Añadir usuario…" />
        </Modal>
    );
}

function CounterModal({ campaign, channels, onClose, onDone }: { campaign: Campaign; channels: ReturnType<typeof useGuildData>['channels']; onClose: () => void; onDone: () => void }) {
    const [channelId, setChannelId] = useState(campaign.counterChannelId ?? '');
    const [saving, setSaving] = useState(false);
    const create = async () => {
        if (!channelId) return toast.error('Elige un canal.');
        setSaving(true);
        try { await post(`/confirmations/campaigns/${campaign.id}/counter`, { channelId }); toast.ok('Mensaje contador creado'); onDone(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title="Crear mensaje contador" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={create}>Crear</button></>}>
            <p className="hint" style={{ margin: 0 }}>El bot publicará un mensaje en el canal y lo mantendrá actualizado con quienes tengan el rol de confirmado. El mensaje anterior, si lo hay, no se borra.</p>
            <label className="field">Canal<ChannelSelect value={channelId} channels={channels} onChange={setChannelId} /></label>
        </Modal>
    );
}

function DeleteModal({ campaign, ids, entries, onClose, onDone }: { campaign: Campaign; ids: string[]; entries: Entry[]; onClose: () => void; onDone: () => void }) {
    const [removeRole, setRemoveRole] = useState(true);
    const [resetNickname, setResetNickname] = useState(false);
    const [working, setWorking] = useState(false);
    const chosen = entries.filter(e => ids.includes(e.userId));
    const go = async () => {
        setWorking(true);
        try {
            const r = await post<{ removed: number; warnings: string[] }>(`/confirmations/campaigns/${campaign.id}/entries/delete`, { userIds: ids, removeRole, resetNickname });
            toast.ok(`${r.removed} borrado${r.removed === 1 ? '' : 's'}`);
            r.warnings.slice(0, 3).forEach(w => toast.error(w));
            onDone();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setWorking(false); }
    };
    return (
        <Modal title={`Borrar ${ids.length} ${ids.length === 1 ? 'confirmado' : 'confirmados'}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn danger" disabled={working} onClick={go}>Borrar</button></>}>
            <div className="muted small" style={{ maxHeight: 90, overflowY: 'auto' }}>{chosen.map(e => e.displayName ?? e.username ?? e.userId).join(', ')}</div>
            <Check checked={removeRole} onChange={setRemoveRole} label="Quitarles también los roles de la campaña en Discord" hint={campaign.confirmedRoleId ? undefined : 'Esta campaña no tiene rol configurado.'} />
            <Check checked={resetNickname} onChange={setResetNickname} label="Restablecer su apodo" />
            <p className="hint" style={{ margin: 0 }}>Si la campaña tiene "No volver a enviar a quien ya respondió", al borrarlos volverán a recibir el formulario en el próximo envío.</p>
        </Modal>
    );
}
