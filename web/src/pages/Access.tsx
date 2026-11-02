import { useEffect, useState } from 'react';
import { get, put } from '../api';
import { PageHead, RoleChecklist, Spinner, errMsg, toast, useGuildData } from '../ui';

export default function Access() {
    const { roles } = useGuildData();
    const [roleIds, setRoleIds] = useState<string[] | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => { get<{ roleIds: string[] }>('/access').then(r => setRoleIds(r.roleIds)).catch(e => toast.error(errMsg(e))); }, []);

    const save = async () => {
        setSaving(true);
        try {
            const r = await put<{ roleIds: string[] }>('/access', { roleIds });
            setRoleIds(r.roleIds); setDirty(false); toast.ok('Acceso guardado');
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <div className="page">
            <PageHead title="Acceso" subtitle="Roles de Discord que pueden entrar al panel como administradores." />
            {!roleIds ? <Spinner /> : (
                <div className="card stack">
                    <RoleChecklist label="Roles de administrador" roles={roles} value={roleIds} onChange={v => { setRoleIds(v); setDirty(true); }}
                        hint="Pueden usar Resumen, Enviar mensaje, Bandeja, Historial, Moderación, Tickets y Registros. Al quitarle el rol a alguien pierde el acceso al momento." />
                    <div className="row"><button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button></div>
                </div>
            )}
        </div>
    );
}
