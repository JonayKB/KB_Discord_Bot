import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put, type GuildEmoji, type ModuleInfo, type ReactionBehavior, type ReactionEntry, type ReactionPanel, type Role } from '../api';
import { useLive } from '../live';
import { Check, ChannelSelect, Empty, Icon, Modal, PageHead, RoleSelect, Spinner, Switch, errMsg, toast, useGuildData } from '../ui';

const BEHAVIORS: Array<{ id: ReactionBehavior; label: string; hint: string }> = [
    { id: 'toggle', label: 'Normal', hint: 'Reaccionar da el rol; quitar la reacción lo quita.' },
    { id: 'add', label: 'Permanente', hint: 'Reaccionar da el rol y ya no se pierde aunque quite la reacción.' },
    { id: 'remove', label: 'Quitar rol', hint: 'Reaccionar le quita el rol (p. ej. "Sin verificar"). Quitar la reacción no hace nada.' },
    { id: 'reverse', label: 'Invertido', hint: 'Reaccionar quita el rol; quitar la reacción lo devuelve.' },
    { id: 'click', label: 'Pulsar', hint: 'Cada vez que reacciona se le da o se le quita el rol, y el bot borra la reacción (necesita "Gestionar mensajes").' },
];
const BEHAVIOR_LABEL = Object.fromEntries(BEHAVIORS.map(b => [b.id, b.label])) as Record<ReactionBehavior, string>;

const CUSTOM_RE = /^<(a?):(\w+):(\d+)>$/;

/** Muestra un emoji guardado: unicode tal cual, personalizado como imagen del CDN de Discord. */
function EmojiView({ value, size = 22 }: { value: string; size?: number }) {
    const m = CUSTOM_RE.exec(value);
    if (m) return <img src={`https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? 'gif' : 'png'}?size=64`} alt={`:${m[2]}:`} title={`:${m[2]}:`} width={size} height={size} style={{ objectFit: 'contain' }} />;
    if (/^\w+$/.test(value)) return <span className="mono" title="Emoji antiguo: solo se conoce el nombre">:{value}:</span>;
    return <span style={{ fontSize: size * 0.9, lineHeight: 1 }}>{value}</span>;
}

function RoleTag({ role, id }: { role?: Role; id: string }) {
    if (!role) return <span className="badge danger">Rol eliminado ({id})</span>;
    return <span className="row" style={{ gap: 6 }}><span className="dot" style={{ background: role.color === '#000000' ? 'var(--muted)' : role.color }} aria-hidden /><b>{role.name}</b><span className="muted small">{role.members} miembros</span></span>;
}

export default function Reactions() {
    const guild = useGuildData();
    const [panels, setPanels] = useState<ReactionPanel[] | null>(null);
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    const [editing, setEditing] = useState<ReactionPanel | 'new' | null>(null);
    const [publishing, setPublishing] = useState<ReactionPanel | null>(null);
    const [deleting, setDeleting] = useState<ReactionPanel | null>(null);
    const [busy, setBusy] = useState<Set<number>>(new Set());

    const load = useCallback(() => {
        get<{ panels: ReactionPanel[] }>('/reactions').then(r => setPanels(r.panels)).catch(e => toast.error(errMsg(e)));
        get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'reactions') ?? null)).catch(() => undefined);
    }, []);
    useEffect(load, [load]);

    useLive(e => {
        if (e.type === 'reactions:changed') load();
        else if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'reactions') ?? null);
    });

    const showWarnings = (warnings: string[], okText: string) => {
        if (warnings.length) warnings.forEach(w => toast.error(w));
        else toast.ok(okText);
    };

    const sync = async (p: ReactionPanel) => {
        setBusy(x => new Set(x).add(p.id));
        try {
            const r = await post<{ warnings: string[] }>(`/reactions/${p.id}/sync`);
            showWarnings(r.warnings, 'Mensaje y reacciones al día');
        } catch (e) { toast.error(errMsg(e)); }
        finally { setBusy(x => { const n = new Set(x); n.delete(p.id); return n; }); }
    };

    const toggle = async (p: ReactionPanel, enabled: boolean) => {
        try { await post(`/reactions/${p.id}/enabled`, { enabled }); load(); } catch (e) { toast.error(errMsg(e)); }
    };

    if (!panels) return <div className="page"><Spinner /></div>;
    const running = mod?.running ?? true;
    const roleById = (id: string) => guild.roles.find(r => r.id === id);
    const channelName = (id: string | null) => guild.channels.find(c => c.id === id)?.name;

    return (
        <div className="page">
            <PageHead title="Roles por reacción" subtitle="Mensajes en los que los miembros reaccionan para conseguir o perder roles. Elige qué hace cada reacción.">
                <button className="btn primary" disabled={!running} onClick={() => setEditing('new')}><Icon name="plus" /> Nuevo mensaje de roles</button>
            </PageHead>

            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Roles por reacción</b> está desactivado: el bot no da ni quita roles al reaccionar. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            {panels.length === 0 ? (
                <div className="card"><Empty title="Aún no hay mensajes de roles">Crea uno para que los miembros elijan sus roles reaccionando.</Empty></div>
            ) : (
                <div className="stack">
                    {panels.map(p => (
                        <div key={p.id} className="card stack">
                            <div className="row between wrap">
                                <div className="row wrap" style={{ minWidth: 0 }}>
                                    <span className={`dot ${p.enabled && running ? 'on' : ''}`} aria-hidden />
                                    <h2 className="ellipsis">{p.name}</h2>
                                    {p.exclusive && <span className="badge accent" title="Solo se puede tener uno de los roles a la vez">Exclusivo</span>}
                                    {p.legacy && <span className="badge" title="Importado de la configuración anterior (/setreaction)">Importado</span>}
                                    {!p.manageEmbed && p.messageId && <span className="badge" title="El bot solo gestiona las reacciones, no edita el texto del mensaje">Mensaje existente</span>}
                                </div>
                                <div className="row wrap">
                                    <label className="row small muted">Activo <Switch checked={p.enabled} disabled={!running} onChange={v => toggle(p, v)} label="Activar este mensaje" /></label>
                                    <button className="btn sm" disabled={!running || busy.has(p.id) || !p.messageId} onClick={() => sync(p)} title="Vuelve a poner las reacciones del bot y actualiza el mensaje"><Icon name="refresh" size={14} /> {busy.has(p.id) ? 'Sincronizando…' : 'Sincronizar'}</button>
                                    <button className="btn sm" disabled={!running} onClick={() => setEditing(p)}><Icon name="edit" size={14} /> Editar</button>
                                    <button className="btn sm danger" disabled={!running} onClick={() => setDeleting(p)} aria-label="Eliminar"><Icon name="trash" size={14} /></button>
                                </div>
                            </div>

                            <div className="table-wrap">
                                <table>
                                    <thead><tr><th style={{ width: 60 }}>Emoji</th><th>Rol</th><th>Comportamiento</th><th>Texto</th></tr></thead>
                                    <tbody>
                                        {p.entries.map((e, i) => (
                                            <tr key={e.id ?? i}>
                                                <td><EmojiView value={e.emoji} /></td>
                                                <td>
                                                    <RoleTag role={roleById(e.roleId)} id={e.roleId} />
                                                    {p.problems[e.roleId] && <div className="small" style={{ color: 'var(--danger)' }}>⚠️ {p.problems[e.roleId]}</div>}
                                                </td>
                                                <td><span className={`badge ${e.behavior === 'remove' || e.behavior === 'reverse' ? 'warn' : e.behavior === 'add' ? 'ok' : 'accent'}`} title={BEHAVIORS.find(b => b.id === e.behavior)?.hint}>{BEHAVIOR_LABEL[e.behavior]}</span></td>
                                                <td className="muted small">{e.label || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="sep" />
                            <div className="row between wrap">
                                <div className="muted small">
                                    {p.messageId
                                        ? <>Mensaje en <b>#{channelName(p.channelId) ?? p.channelId}</b> · <span className="mono">{p.messageId}</span></>
                                        : 'Sin publicar en Discord.'}
                                </div>
                                <button className="btn sm" disabled={!running} onClick={() => setPublishing(p)}>{p.messageId ? 'Publicar en otro canal' : 'Publicar'}</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editing && <PanelEditor initial={editing === 'new' ? null : editing} guild={guild} onClose={() => setEditing(null)} onSaved={w => { setEditing(null); showWarnings(w, 'Guardado'); load(); }} />}
            {publishing && <PublishModal panel={publishing} channels={guild.channels} onClose={() => setPublishing(null)} onDone={w => { setPublishing(null); showWarnings(w, 'Mensaje publicado'); load(); }} />}
            {deleting && <DeleteModal panel={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); toast.ok('Eliminado'); load(); }} />}
        </div>
    );
}

// ───────────────────────────── Editor ─────────────────────────────

type Draft = Pick<ReactionPanel, 'name' | 'enabled' | 'exclusive' | 'title' | 'description' | 'color' | 'showList'> & { entries: ReactionEntry[] };

const emptyEntry = (): ReactionEntry => ({ emoji: '', roleId: '', behavior: 'toggle', label: '' });

function PanelEditor({ initial, guild, onClose, onSaved }: { initial: ReactionPanel | null; guild: ReturnType<typeof useGuildData>; onClose: () => void; onSaved: (warnings: string[]) => void }) {
    const [d, setD] = useState<Draft>(() => initial
        ? { name: initial.name, enabled: initial.enabled, exclusive: initial.exclusive, title: initial.title, description: initial.description, color: initial.color, showList: initial.showList, entries: initial.entries.map(e => ({ ...e })) }
        : { name: '', enabled: true, exclusive: false, title: '', description: 'Reacciona para conseguir tus roles:', color: '#5865F2', showList: true, entries: [emptyEntry()] });
    const [source, setSource] = useState<'new' | 'existing'>('new');
    const [channelId, setChannelId] = useState('');
    const [messageId, setMessageId] = useState('');
    const [emojis, setEmojis] = useState<GuildEmoji[]>([]);
    const [pickFor, setPickFor] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const set = (patch: Partial<Draft>) => setD(x => ({ ...x, ...patch }));
    const setEntry = (i: number, patch: Partial<ReactionEntry>) => setD(x => ({ ...x, entries: x.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));

    useEffect(() => { get<GuildEmoji[]>('/reactions/emojis').then(setEmojis).catch(() => undefined); }, []);

    // El embed solo lo controla el bot si lo publicó él.
    const managesEmbed = initial ? initial.manageEmbed || !initial.messageId : source === 'new';

    const save = async () => {
        if (!d.name.trim()) return toast.error('Ponle un nombre.');
        if (d.entries.some(e => !e.emoji.trim() || !e.roleId)) return toast.error('Cada reacción necesita un emoji y un rol.');
        if (!initial && !channelId && !(source === 'existing' && /channels\//.test(messageId))) return toast.error('Elige un canal.');
        if (!initial && source === 'existing' && !messageId.trim()) return toast.error('Pega el enlace o el ID del mensaje.');
        setSaving(true);
        try {
            const body = { ...d, name: d.name.trim() };
            const r = initial
                ? await put<{ warnings: string[] }>(`/reactions/${initial.id}`, body)
                : await post<{ warnings: string[] }>('/reactions', { ...body, source, channelId, messageId: messageId.trim() });
            onSaved(r.warnings);
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal wide title={initial ? `Editar "${initial.name}"` : 'Nuevo mensaje de roles'} onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : initial ? 'Guardar' : source === 'new' ? 'Crear y publicar' : 'Guardar'}</button>
        </>}>
            <label className="field">Nombre (solo para el panel)<input type="text" maxLength={80} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="Roles de juegos" /></label>

            {!initial && (
                <>
                    <div className="seg">
                        <button type="button" className={source === 'new' ? 'on' : ''} onClick={() => setSource('new')}>Publicar un mensaje nuevo</button>
                        <button type="button" className={source === 'existing' ? 'on' : ''} onClick={() => setSource('existing')}>Usar un mensaje que ya existe</button>
                    </div>
                    <div className="grid cols-2">
                        <label className="field">Canal<ChannelSelect value={channelId} channels={guild.channels} onChange={setChannelId} /></label>
                        {source === 'existing' && (
                            <label className="field">Enlace o ID del mensaje
                                <input type="text" value={messageId} onChange={e => setMessageId(e.target.value)} placeholder="https://discord.com/channels/…" spellCheck={false} />
                            </label>
                        )}
                    </div>
                    {source === 'existing' && <span className="hint" style={{ marginTop: -6 }}>El bot solo añade las reacciones; el texto del mensaje no se toca. Con el enlace no hace falta elegir el canal.</span>}
                </>
            )}

            {managesEmbed && (
                <>
                    <div className="grid cols-2">
                        <label className="field">Título<input type="text" maxLength={256} value={d.title} onChange={e => set({ title: e.target.value })} placeholder={d.name || 'Elige tus roles'} /></label>
                        <label className="field">Color<input type="color" value={d.color} onChange={e => set({ color: e.target.value.toUpperCase() })} /></label>
                    </div>
                    <label className="field">Descripción<textarea maxLength={3000} value={d.description} onChange={e => set({ description: e.target.value })} /></label>
                    <Check checked={d.showList} onChange={showList => set({ showList })} label="Añadir al mensaje la lista de emojis y roles" />
                </>
            )}

            <div className="sep" />
            <div className="row between"><b>Reacciones</b><span className="muted small">Puedes repetir un emoji para que haga varias cosas a la vez (p. ej. dar "Verificado" y quitar "Sin verificar").</span></div>

            <div className="stack" style={{ gap: 10 }}>
                {d.entries.map((e, i) => (
                    <div key={i} className="tile stack" style={{ gap: 8 }}>
                        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                            <label className="field" style={{ width: 150 }}>Emoji
                                <span className="row" style={{ gap: 6 }}>
                                    <input type="text" value={e.emoji} onChange={ev => setEntry(i, { emoji: ev.target.value })} placeholder="😀 o :nombre:" spellCheck={false} />
                                    {emojis.length > 0 && <button type="button" className="btn sm ghost icon" title="Emojis del servidor" onClick={() => setPickFor(pickFor === i ? null : i)}><Icon name="smile" size={16} /></button>}
                                </span>
                            </label>
                            <label className="field grow" style={{ minWidth: 160 }}>Rol<RoleSelect value={e.roleId || null} roles={guild.roles} empty="— Elige un rol —" onChange={v => setEntry(i, { roleId: v ?? '' })} /></label>
                            <label className="field" style={{ minWidth: 150 }}>Comportamiento
                                <select value={e.behavior} onChange={ev => setEntry(i, { behavior: ev.target.value as ReactionBehavior })}>
                                    {BEHAVIORS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                                </select>
                            </label>
                            <button type="button" className="btn sm danger" disabled={d.entries.length === 1} onClick={() => set({ entries: d.entries.filter((_, j) => j !== i) })} aria-label="Quitar reacción"><Icon name="trash" size={14} /></button>
                        </div>
                        {pickFor === i && (
                            <div className="row wrap" style={{ gap: 4 }}>
                                {emojis.map(em => (
                                    <button key={em.id} type="button" className="btn sm ghost icon" title={`:${em.name}:`} onClick={() => { setEntry(i, { emoji: em.value }); setPickFor(null); }}>
                                        <img src={em.url} alt={em.name} width={22} height={22} style={{ objectFit: 'contain' }} />
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="row wrap">
                            {e.emoji && CUSTOM_RE.test(e.emoji) && <EmojiView value={e.emoji} />}
                            <span className="hint grow">{BEHAVIORS.find(b => b.id === e.behavior)?.hint}</span>
                        </div>
                        {managesEmbed && d.showList && (
                            <input type="text" maxLength={100} value={e.label} onChange={ev => setEntry(i, { label: ev.target.value })} placeholder="Texto junto al rol en el mensaje (opcional)" />
                        )}
                    </div>
                ))}
            </div>
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ entries: [...d.entries, emptyEntry()] })}><Icon name="plus" size={14} /> Añadir reacción</button>

            <div className="sep" />
            <Check checked={d.exclusive} onChange={exclusive => set({ exclusive })} label="Exclusivo: solo un rol de este mensaje a la vez"
                hint="Al elegir uno se quitan los demás (y sus reacciones). Afecta a los comportamientos Normal, Permanente y Pulsar." />
            <Check checked={d.enabled} onChange={enabled => set({ enabled })} label="Activo" hint="Si lo desactivas, el mensaje se queda pero el bot deja de dar y quitar roles." />
            {initial && <span className="hint">Cambiar o quitar reacciones no le quita el rol a quien ya lo tiene.</span>}
        </Modal>
    );
}

function PublishModal({ panel, channels, onClose, onDone }: { panel: ReactionPanel; channels: ReturnType<typeof useGuildData>['channels']; onClose: () => void; onDone: (w: string[]) => void }) {
    const [channelId, setChannelId] = useState(panel.channelId ?? '');
    const [saving, setSaving] = useState(false);
    const go = async () => {
        if (!channelId) return toast.error('Elige un canal.');
        setSaving(true);
        try { const r = await post<{ warnings: string[] }>(`/reactions/${panel.id}/publish`, { channelId }); onDone(r.warnings); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title={`Publicar · ${panel.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={go}>Publicar</button></>}>
            <p className="hint" style={{ margin: 0 }}>
                El bot publicará un mensaje nuevo con el embed y las reacciones, y dejará de vigilar el anterior (se queda en Discord; puedes borrarlo a mano).
                Los roles que ya tiene la gente no cambian.
            </p>
            <label className="field">Canal<ChannelSelect value={channelId} channels={channels} onChange={setChannelId} /></label>
        </Modal>
    );
}

function DeleteModal({ panel, onClose, onDone }: { panel: ReactionPanel; onClose: () => void; onDone: () => void }) {
    const canDelete = panel.manageEmbed && !!panel.messageId;
    const [withMessage, setWithMessage] = useState(false);
    const [saving, setSaving] = useState(false);
    const go = async () => {
        setSaving(true);
        try { await del(`/reactions/${panel.id}${withMessage ? '?message=1' : ''}`); onDone(); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title="Eliminar mensaje de roles" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn danger" disabled={saving} onClick={go}>Eliminar</button></>}>
            <p style={{ margin: 0 }}>El bot dejará de dar y quitar roles con <b>{panel.name}</b>. Nadie pierde los roles que ya tiene.</p>
            {canDelete && <Check checked={withMessage} onChange={setWithMessage} label="Borrar también el mensaje de Discord" />}
        </Modal>
    );
}
