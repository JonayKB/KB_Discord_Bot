import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post, put, type Campaign, type GameServer, type Member, type WhitelistEntry, type WhitelistSettings, type WhitelistStatus } from '../api';
import { fmtDateTime, fmtRelative } from '../format';
import { useLive } from '../live';
import { Check, Empty, Icon, Modal, Spinner, Switch, UserPicker, errMsg, rememberMember, toast, useConfirm, useMemberLabel } from '../ui';

const STATUS: Record<WhitelistStatus, [string, string]> = {
    active: ['En la whitelist', 'ok'],
    pending_add: ['Pendiente de añadir', 'warn'],
    pending_remove: ['Pendiente de quitar', 'warn'],
    removed: ['Quitado', ''],
    error: ['Rechazado', 'danger'],
};

/** Sección RCON de un servidor de Minecraft: conexión, consola y whitelist automática. */
export default function ServerRcon({ server, running }: { server: GameServer; running: boolean }) {
    const configured = !!server.rcon.port && server.rcon.hasPassword;
    return (
        <div className="stack">
            <RconConnection server={server} running={running} />
            {configured && <RconConsole server={server} running={running} />}
            {configured ? <WhitelistPanel server={server} running={running} /> : <div className="hint">Configura la conexión RCON para usar la consola y la whitelist automática.</div>}
        </div>
    );
}

// ───────────────────────────── Conexión ─────────────────────────────

function RconConnection({ server, running }: { server: GameServer; running: boolean }) {
    const [port, setPort] = useState(server.rcon.port ? String(server.rcon.port) : '');
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);

    const save = async () => {
        if (!/^\d+$/.test(port)) return toast.error('Indica el puerto RCON (rcon.port en server.properties).');
        if (!server.rcon.hasPassword && !password) return toast.error('Indica la contraseña (rcon.password).');
        setSaving(true);
        try { await put(`/servers/${server.id}/rcon`, { port: Number(port), ...(password ? { password } : {}) }); setPassword(''); toast.ok('RCON guardado'); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };
    const test = async () => {
        setTesting(true);
        try { const r = await post<{ output: string }>(`/servers/${server.id}/rcon/test`); toast.ok(`✅ Conectado: ${r.output || 'OK'}`); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setTesting(false); }
    };

    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="row between wrap">
                <b>Conexión RCON</b>
                {server.rcon.port && server.rcon.hasPassword ? <span className="badge ok">Configurado</span> : <span className="badge">Sin configurar</span>}
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="field" style={{ width: 140 }}>Puerto<input type="number" min={1} max={65535} value={port} onChange={e => setPort(e.target.value)} placeholder="25575" /></label>
                <label className="field grow" style={{ minWidth: 200 }}>Contraseña
                    <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
                        placeholder={server.rcon.hasPassword ? '•••••••• (guardada; escribe para cambiarla)' : 'rcon.password'} />
                </label>
                <button className="btn" disabled={!running || saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
                <button className="btn" disabled={!running || testing || !server.rcon.hasPassword} onClick={test}>{testing ? 'Probando…' : 'Probar'}</button>
            </div>
            <span className="hint">En <code>server.properties</code>: <code>enable-rcon=true</code>, <code>rcon.port</code> y <code>rcon.password</code>. Se conecta a {server.host}. La contraseña se guarda en el bot y nunca se muestra.</span>
        </div>
    );
}

// ───────────────────────────── Consola ─────────────────────────────

function RconConsole({ server, running }: { server: GameServer; running: boolean }) {
    const [lines, setLines] = useState<Array<{ kind: 'cmd' | 'out' | 'err'; text: string }>>([]);
    const [cmd, setCmd] = useState('');
    const [busy, setBusy] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [hIdx, setHIdx] = useState(-1);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines]);

    const send = async () => {
        const c = cmd.trim();
        if (!c) return;
        setBusy(true);
        setLines(l => [...l, { kind: 'cmd', text: `> ${c}` }]);
        setHistory(h => [c, ...h.filter(x => x !== c)].slice(0, 30));
        setHIdx(-1);
        setCmd('');
        try { const r = await post<{ output: string }>(`/servers/${server.id}/rcon/command`, { command: c }); setLines(l => [...l, { kind: 'out', text: r.output || '(sin respuesta)' }]); }
        catch (e) { setLines(l => [...l, { kind: 'err', text: errMsg(e) }]); }
        finally { setBusy(false); }
    };

    return (
        <div className="stack" style={{ gap: 8 }}>
            <div className="row between"><b>Consola</b>{lines.length > 0 && <button className="btn sm ghost" onClick={() => setLines([])}>Limpiar</button>}</div>
            <div className="console" ref={box} aria-live="polite">
                {lines.length === 0 ? <span style={{ opacity: .6 }}>Escribe un comando de Minecraft (sin la barra), p. ej. <i>list</i> o <i>say Hola</i>.</span>
                    : lines.map((l, i) => <div key={i} className={l.kind === 'cmd' ? 'cmd' : l.kind === 'err' ? 'err' : ''}>{l.text}</div>)}
            </div>
            <div className="row">
                <input type="text" className="grow mono" value={cmd} disabled={!running} placeholder="comando…" spellCheck={false} onChange={e => setCmd(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); void send(); }
                        else if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); const i = Math.min(hIdx + 1, history.length - 1); setHIdx(i); setCmd(history[i]); }
                        else if (e.key === 'ArrowDown') { e.preventDefault(); const i = hIdx - 1; setHIdx(Math.max(i, -1)); setCmd(i >= 0 ? history[i] : ''); }
                    }} />
                <button className="btn primary" disabled={!running || busy || !cmd.trim()} onClick={send}>Enviar</button>
            </div>
            <span className="hint">Los comandos se ejecutan con permisos de consola y quedan en los Registros.</span>
        </div>
    );
}

// ───────────────────────────── Whitelist ─────────────────────────────

function WhoCell({ e }: { e: WhitelistEntry }) {
    const label = useMemberLabel(e.userId);
    return <span>{label !== e.userId ? label : e.username ?? e.userId}</span>;
}

function WhitelistPanel({ server, running }: { server: GameServer; running: boolean }) {
    const confirm = useConfirm();
    const [settings, setSettings] = useState<WhitelistSettings | null>(null);
    const [dirty, setDirty] = useState(false);
    const [entries, setEntries] = useState<WhitelistEntry[] | null>(null);
    const [history, setHistory] = useState(false);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [adding, setAdding] = useState(false);
    const [viewServer, setViewServer] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
        get<{ settings: WhitelistSettings; entries: WhitelistEntry[] }>(`/servers/${server.id}/whitelist${history ? '?history=1' : ''}`)
            .then(r => { setEntries(r.entries); setSettings(s => (dirty && s ? s : r.settings)); })
            .catch(e => toast.error(errMsg(e)));
    }, [server.id, history, dirty]);
    useEffect(load, [load]);
    useEffect(() => { get<Campaign[]>('/confirmations/campaigns').then(setCampaigns).catch(() => undefined); }, []);
    useLive(e => { if (e.type === 'whitelist:changed' && e.data?.serverId === server.id) load(); });

    if (!settings || !entries) return <Spinner />;
    const set = (patch: Partial<WhitelistSettings>) => { setSettings({ ...settings, ...patch }); setDirty(true); };

    const saveSettings = async () => {
        try { setSettings(await put<WhitelistSettings>(`/servers/${server.id}/whitelist/settings`, settings)); setDirty(false); toast.ok('Whitelist guardada'); }
        catch (e) { toast.error(errMsg(e)); }
    };
    const remove = async (e: WhitelistEntry) => {
        const cleanup = e.status === 'removed' || e.status === 'error';
        if (!cleanup && !(await confirm({
            title: `Quitar ${e.mcName}`,
            message: e.preexisting ? <>Ya estaba en la whitelist antes de vincularlo, así que <b>no se quitará del servidor</b>: solo se desvincula de este usuario.</> : <>Se quitará <b>{e.mcName}</b> de la whitelist del servidor.</>,
            confirmLabel: 'Quitar', danger: true,
        }))) return;
        try { await del(`/servers/${server.id}/whitelist/${e.id}`); load(); } catch (err) { toast.error(errMsg(err)); }
    };
    const action = async (path: string, ok: string) => {
        setBusy(true);
        try {
            const r = await post<{ added?: number; unchanged?: number; skipped?: Array<{ user: string; name: string; reason: string }> }>(`/servers/${server.id}/whitelist/${path}`);
            if (r.added !== undefined) {
                toast.ok(`Añadidos: ${r.added} · ya estaban: ${r.unchanged ?? 0}${r.skipped?.length ? ` · saltados: ${r.skipped.length}` : ''}`);
                r.skipped?.slice(0, 5).forEach(s => toast.error(`${s.user} (${s.name}): ${s.reason}`));
            } else toast.ok(ok);
            load();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setBusy(false); }
    };

    const pending = entries.filter(e => e.status === 'pending_add' || e.status === 'pending_remove').length;
    const activeCount = entries.filter(e => e.status === 'active').length;

    return (
        <div className="stack" style={{ gap: 12 }}>
            <div className="sep" />
            <div className="row between wrap">
                <div>
                    <b>Whitelist automática</b>
                    <div className="hint">Quien confirme en la campaña elegida entra en la whitelist con el nombre que escriba. Un nombre por persona y sin repetidos.</div>
                </div>
                <label className="row small muted">Activa <Switch checked={settings.enabled} disabled={!running} onChange={enabled => set({ enabled })} label="Activar whitelist automática" /></label>
            </div>

            <div className="grid cols-2">
                <label className="field">Campaña de la que salen los nombres
                    <select value={settings.campaignId ?? ''} onChange={e => set({ campaignId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">— Elige una campaña —</option>
                        {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <span className="hint">Lo que respondan en el formulario será su nombre de Minecraft.</span>
                </label>
                <div className="stack" style={{ gap: 8 }}>
                    <Check checked={settings.onlineMode} onChange={onlineMode => set({ onlineMode })} label="Servidor premium (online-mode)"
                        hint="Comprueba con Mojang que la cuenta existe y guarda su UUID: ni con otras mayúsculas ni tras cambiar el nombre en Minecraft se puede registrar la misma cuenta dos veces." />
                    <Check checked={settings.removeOnLeave} onChange={removeOnLeave => set({ removeOnLeave })} label="Quitar de la whitelist al salir del Discord (o ser baneado)" />
                </div>
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <Check checked={settings.allowRename} onChange={allowRename => set({ allowRename })} label="Permitir que cambien su nombre ellos mismos"
                    hint={settings.allowRename ? 'Al cambiarlo, primero se quita el viejo y luego se añade el nuevo.' : 'Si no, tendrán que pedírselo al staff (p. ej. con un ticket); desde aquí siempre puedes cambiarlo.'} />
                {settings.allowRename && (
                    <label className="field" style={{ width: 220 }}>Como mucho una vez cada
                        <select value={settings.renameCooldownDays} onChange={e => set({ renameCooldownDays: Number(e.target.value) })}>
                            {[0, 1, 7, 14, 30, 90].map(d => <option key={d} value={d}>{d === 0 ? 'Sin límite' : `${d} ${d === 1 ? 'día' : 'días'}`}</option>)}
                        </select>
                    </label>
                )}
                <div className="grow" />
                <button className="btn primary" disabled={!running || !dirty} onClick={saveSettings}>Guardar ajustes</button>
            </div>

            <div className="row between wrap">
                <div className="row wrap">
                    <b>Jugadores</b>
                    <span className="badge ok">{activeCount} en la whitelist</span>
                    {pending > 0 && <span className="badge warn" title="Se aplican en cuanto el servidor responde por RCON">{pending} pendientes</span>}
                </div>
                <div className="row wrap">
                    <label className="row small muted"><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} /> Ver quitados</label>
                    <button className="btn sm" disabled={!running} onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Añadir</button>
                    <button className="btn sm" disabled={!running || busy || !settings.campaignId} onClick={() => action('import', '')} title="Añade a los que ya confirmaron antes de activar la whitelist">Importar confirmados</button>
                    {pending > 0 && <button className="btn sm" disabled={!running || busy} onClick={() => action('process', 'Pendientes procesados')}><Icon name="refresh" size={14} /> Reintentar</button>}
                    <button className="btn sm ghost" disabled={!running} onClick={() => setViewServer(true)}>Ver whitelist del servidor</button>
                </div>
            </div>

            {entries.length === 0 ? <Empty title="Nadie todavía">Cuando alguien confirme en la campaña aparecerá aquí.</Empty> : (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Discord</th><th>Minecraft</th><th>Estado</th><th>Desde</th><th /></tr></thead>
                        <tbody>
                            {entries.map(e => (
                                <tr key={e.id}>
                                    <td><WhoCell e={e} /></td>
                                    <td className="mono">{e.mcName}{e.preexisting && <span className="badge" style={{ marginLeft: 6 }} title="Ya estaba en la whitelist: el bot nunca lo quitará del servidor">ya estaba</span>}</td>
                                    <td>
                                        <span className={`badge ${STATUS[e.status][1]}`}>{STATUS[e.status][0]}</span>
                                        {e.error && <div className="small" style={{ color: 'var(--danger)' }}>{e.error}</div>}
                                        {e.status === 'removed' && e.removedReason && <div className="small muted">{e.removedReason}</div>}
                                    </td>
                                    <td className="small muted" title={fmtDateTime(e.createdAt)}>{fmtRelative(e.createdAt)}{e.source !== 'form' && ` · ${e.source === 'panel' ? `panel${e.addedBy ? ` (${e.addedBy})` : ''}` : 'importado'}`}</td>
                                    <td style={{ textAlign: 'right' }}>
                                        {e.status !== 'pending_remove' && (
                                            <button className="btn sm ghost icon" disabled={!running} onClick={() => remove(e)} aria-label={e.status === 'removed' || e.status === 'error' ? 'Borrar del historial' : `Quitar ${e.mcName}`}><Icon name="trash" size={14} /></button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {adding && <AddModal server={server} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
            {viewServer && <ServerListModal server={server} onClose={() => setViewServer(false)} />}
        </div>
    );
}

function AddModal({ server, onClose, onDone }: { server: GameServer; onClose: () => void; onDone: () => void }) {
    const [member, setMember] = useState<Member | null>(null);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const save = async () => {
        if (!member) return toast.error('Elige el usuario de Discord.');
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return toast.error('Nombre de Minecraft no válido (3-16 letras, números o _).');
        setSaving(true);
        try {
            const e = await post<WhitelistEntry>(`/servers/${server.id}/whitelist`, { userId: member.id, name });
            toast.ok(e.status === 'active' ? `${e.mcName} añadido` : `${e.mcName} se añadirá en cuanto el servidor responda`);
            onDone();
        } catch (err) { toast.error(errMsg(err)); }
        finally { setSaving(false); }
    };
    return (
        <Modal title={`Añadir a la whitelist · ${server.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={saving} onClick={save}>Añadir</button></>}>
            <div className="field"><span>Usuario de Discord</span>
                {member ? <div className="row between"><b>{member.displayName}</b><button className="btn sm ghost" onClick={() => setMember(null)}>Cambiar</button></div>
                    : <UserPicker onPick={m => { rememberMember(m); setMember(m); }} />}
            </div>
            <label className="field">Nombre de Minecraft<input type="text" maxLength={16} value={name} onChange={e => setName(e.target.value.trim())} spellCheck={false} /></label>
            <p className="hint" style={{ margin: 0 }}>Si ya tenía otro nombre, se le cambia (el viejo sale de la whitelist). No se puede asignar un nombre que ya tenga otra persona.</p>
        </Modal>
    );
}

function ServerListModal({ server, onClose }: { server: GameServer; onClose: () => void }) {
    const [list, setList] = useState<Array<{ name: string; userId: string | null; username: string | null }> | null>(null);
    useEffect(() => { get<typeof list>(`/servers/${server.id}/whitelist/server`).then(setList).catch(e => { toast.error(errMsg(e)); onClose(); }); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const unlinked = list?.filter(x => !x.userId).length ?? 0;
    return (
        <Modal title={`Whitelist real de ${server.name}`} onClose={onClose}>
            {!list ? <Spinner /> : list.length === 0 ? <Empty title="La whitelist está vacía" /> : (
                <>
                    <p className="hint" style={{ margin: 0 }}>{list.length} nombres en el servidor{unlinked ? ` · ${unlinked} sin vincular a nadie (añadidos a mano)` : ''}.</p>
                    <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                        <table>
                            <thead><tr><th>Minecraft</th><th>Discord</th></tr></thead>
                            <tbody>{list.map(x => <tr key={x.name}><td className="mono">{x.name}</td><td>{x.username ?? <span className="muted">Sin vincular</span>}</td></tr>)}</tbody>
                        </table>
                    </div>
                </>
            )}
        </Modal>
    );
}
