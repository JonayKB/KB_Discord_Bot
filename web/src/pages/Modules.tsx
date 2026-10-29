import { useCallback, useEffect, useState } from 'react';
import { get, post, type ModuleInfo } from '../api';
import { useLive } from '../live';
import { PageHead, Spinner, Switch, errMsg, toast } from '../ui';

const HELP: Record<string, string> = {
    messages: 'Al desactivarlo, el bot NO envía ningún mensaje (botón de pausa de emergencia). El historial se sigue viendo.',
    inbox: 'Al desactivarlo, el bot deja de guardar los MD que recibe y de reenviarlos.',
    scheduler: 'Al desactivarlo, las tareas programadas quedan en pausa (no se pierden).',
    confirmations: 'Al desactivarlo, los botones de los formularios dejan de responder y se pausa el contador.',
    servers: 'Al desactivarlo, se deja de consultar los servidores y el mensaje de estado en Discord se queda congelado.',
};

export default function Modules() {
    const [mods, setMods] = useState<ModuleInfo[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(() => { get<ModuleInfo[]>('/modules').then(setMods).catch(e => toast.error(errMsg(e))); }, []);
    useEffect(load, [load]);
    useLive(e => { if (e.type === 'modules:changed') setMods(e.data as ModuleInfo[]); });

    const toggle = async (id: string, enabled: boolean) => {
        setBusy(id);
        try { setMods(await post<ModuleInfo[]>(`/modules/${id}/enabled`, { enabled })); toast.ok(enabled ? 'Módulo activado' : 'Módulo desactivado'); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setBusy(null); }
    };

    return (
        <div className="page">
            <PageHead title="Módulos" subtitle="Cada función del bot es independiente. Actívala o desactívala al instante, sin reiniciar." />
            {!mods ? <Spinner /> : (
                <div className="grid cols-2">
                    {mods.map(m => (
                        <div key={m.id} className="card stack" style={{ gap: 10 }}>
                            <div className="row between">
                                <div className="row"><h2>{m.name}</h2>
                                    {m.error ? <span className="badge danger">Error</span> : m.running ? <span className="badge ok">Activo</span> : <span className="badge">Desactivado</span>}
                                </div>
                                <Switch checked={m.enabled} disabled={busy === m.id} onChange={v => toggle(m.id, v)} label={`Activar ${m.name}`} />
                            </div>
                            <p className="muted" style={{ margin: 0 }}>{m.description}</p>
                            {HELP[m.id] && <p className="hint" style={{ margin: 0 }}>ℹ️ {HELP[m.id]}</p>}
                            {m.error && <div className="alert danger">{m.error}</div>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
