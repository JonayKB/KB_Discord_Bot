import { useCallback, useEffect, useState } from 'react';
import { get, put, type ModuleInfo, type VerificationConfig, type VerificationGroup, type VerificationStatus } from '../api';
import { fmtDateTime } from '../format';
import { useLive } from '../live';
import { ChannelSelect, Empty, PageHead, RoleSelect, Spinner, Switch, errMsg, toast, useConfirm, useGuildData } from '../ui';

const GROUPS: Array<{ id: VerificationGroup; title: string; hint: string }> = [
    { id: 'unverified', title: 'Sin verificar', hint: 'Solo tiene el rol de sin verificar, ningún otro.' },
    { id: 'confirmed', title: 'Confirmado sin verificar', hint: 'Tiene el de sin verificar y el de confirmado, pero no el de verificado.' },
];
const ROLES = [
    ['unverifiedRoleId', 'Sin verificar'],
    ['confirmedRoleId', 'Confirmado'],
    ['verifiedRoleId', 'Verificado'],
] as const;

export default function Verification() {
    const guild = useGuildData();
    const confirm = useConfirm();
    const [cfg, setCfg] = useState<VerificationConfig | null>(null);
    const [wasEnabled, setWasEnabled] = useState(false);
    const [status, setStatus] = useState<VerificationStatus | null>(null);
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const loadStatus = useCallback(() => { get<VerificationStatus>('/verification/status').then(setStatus).catch(e => toast.error(errMsg(e))); }, []);
    useEffect(() => {
        get<VerificationConfig>('/verification').then(c => { setCfg(c); setWasEnabled(c.enabled); }).catch(e => toast.error(errMsg(e)));
        get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'verification') ?? null)).catch(() => undefined);
        loadStatus();
    }, [loadStatus]);
    useLive(e => {
        if (e.type === 'verification:changed') loadStatus();
        if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'verification') ?? null);
    });

    if (!cfg) return <div className="page"><Spinner /></div>;
    const running = mod?.running ?? true;
    const set = (patch: Partial<VerificationConfig>) => { setCfg({ ...cfg, ...patch }); setDirty(true); };
    const setGroup = (id: VerificationGroup, patch: Partial<VerificationConfig['groups'][VerificationGroup]>) =>
        set({ groups: { ...cfg.groups, [id]: { ...cfg.groups[id], ...patch } } });

    const save = async () => {
        if (cfg.enabled && !wasEnabled && !(await confirm({
            title: 'Activar la expulsión automática',
            message: <>En unos minutos empezarán los avisos. Quien no se verifique será expulsado al acabar su plazo: <b>{cfg.groups.unverified.days} días</b> sin verificar y <b>{cfg.groups.confirmed.days} días</b> si ya confirmó. Al expulsar a alguien también sale de las whitelists que tengan «quitar al salir del Discord».</>,
            confirmLabel: 'Activar', danger: true,
        }))) return;
        setSaving(true);
        try {
            const saved = await put<VerificationConfig>('/verification', cfg);
            setCfg(saved);
            setWasEnabled(saved.enabled);
            setDirty(false);
            loadStatus();
            toast.ok('Verificación guardada');
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <div className="page">
            <PageHead title="Verificación" subtitle="Avisa cada día a quien no se ha verificado y lo expulsa cuando se le acaba el plazo.">
                {dirty && <span className="muted small">Cambios sin guardar</span>}
                <button className="btn primary" disabled={!running || saving || !dirty} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
            </PageHead>

            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Verificación</b> está desactivado: no se avisa ni se expulsa a nadie. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            <div className="stack">
                <div className="card stack">
                    <div className="row between wrap">
                        <div><h2>Expulsión automática</h2><div className="hint">El plazo empieza con el primer aviso, también para quien ya llevaba tiempo en el servidor. Si el módulo Mensajes está en pausa, no se expulsa a nadie.</div></div>
                        <Switch checked={cfg.enabled} onChange={enabled => set({ enabled })} label="Activar la expulsión automática" />
                    </div>
                    <div className="grid cols-3">
                        {ROLES.map(([key, label]) => (
                            <label key={key} className="field">Rol: {label}<RoleSelect value={cfg[key]} roles={guild.roles} onChange={v => set({ [key]: v })} /></label>
                        ))}
                    </div>
                    <div className="grid cols-2">
                        <label className="field">Canal de normas y verificación
                            <ChannelSelect value={cfg.rulesChannelId ?? ''} channels={guild.channels} onChange={v => set({ rulesChannelId: v || null })} />
                            <span className="hint">Se enlaza en cada aviso.</span>
                        </label>
                        <label className="field">Canal para quien tiene los MD cerrados
                            <ChannelSelect value={cfg.fallbackChannelId ?? ''} channels={guild.channels} onChange={v => set({ fallbackChannelId: v || null })} />
                            <span className="hint">Se le menciona ahí. Debe poder verlo alguien sin verificar. Sin canal, el plazo corre igualmente.</span>
                        </label>
                    </div>
                </div>

                <div className="grid cols-2" style={{ alignItems: 'start' }}>
                    {GROUPS.map(({ id, title, hint }) => (
                        <div key={id} className="card stack">
                            <div><h2>{title}</h2><div className="hint">{hint}</div></div>
                            <label className="field">Días de plazo (un aviso al día)
                                <input type="number" min={1} max={60} value={cfg.groups[id].days || ''} onChange={e => setGroup(id, { days: Number(e.target.value) })} />
                                <span className="hint">Si lo cambias, quien ya recibió un aviso conserva el plazo que se le dijo.</span>
                            </label>
                            <label className="field">Mensaje
                                <textarea rows={7} maxLength={1500} value={cfg.groups[id].message} onChange={e => setGroup(id, { message: e.target.value })} />
                                <span className="hint">Admite {'{user}'} y {'{server}'}. El tiempo restante, el motivo y el canal se añaden solos.</span>
                            </label>
                            <label className="field">Motivo de la expulsión
                                <textarea rows={3} maxLength={400} value={cfg.groups[id].reason} onChange={e => setGroup(id, { reason: e.target.value })} />
                            </label>
                        </div>
                    ))}
                </div>

                <PendingList status={status} />
            </div>
        </div>
    );
}

function PendingList({ status }: { status: VerificationStatus | null }) {
    if (!status) return <div className="card"><Spinner /></div>;
    return (
        <div className="card stack">
            <div>
                <h2>Afectados {!status.problem && <span className="muted">({status.members.length})</span>}</h2>
                <div className="hint">Según los roles guardados. Puedes guardar sin activar para revisar antes la lista.</div>
            </div>
            {status.problem ? <div className="alert info">{status.problem}</div> : !status.members.length ? <Empty title="No hay nadie pendiente de verificar" /> : (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Usuario</th><th>Grupo</th><th>Avisos</th><th>Expulsión</th></tr></thead>
                        <tbody>
                            {status.members.map(m => (
                                <tr key={m.userId}>
                                    <td><b>{m.displayName}</b> <span className="muted small">@{m.username}</span></td>
                                    <td>{GROUPS.find(g => g.id === m.group)?.title}</td>
                                    <td className="small">
                                        {m.warnings} de {m.days}
                                        {m.delivery === 'channel' && <span className="muted"> · por canal</span>}
                                        {m.error && <div style={{ color: 'var(--warn)' }}>{m.error}</div>}
                                    </td>
                                    <td className="small muted">{m.kickAt ? fmtDateTime(m.kickAt) : 'Plazo sin empezar'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
