import { useCallback, useEffect, useMemo, useState } from 'react';
import { del, get, post, put, type Campaign, type Channel, type Job, type Role, type Target, type Template } from '../api';
import { DEFAULT_TZ, fmtDateTime, fmtRelative, pad, utcToZoned, validTz, zonedToUtc } from '../format';
import { useLive } from '../live';
import { go } from '../nav';
import { Check, Empty, Icon, Modal, PageHead, Spinner, Switch, TargetPicker, errMsg, targetReady, toast, useConfirm, useGuildData, useMemberLabel } from '../ui';

type Mode = 'daily' | 'weekly' | 'interval' | 'once' | 'cron';
type Unit = 'minutes' | 'hours' | 'days';

interface Draft {
    name: string;
    enabled: boolean;
    mode: Mode;
    time: string;
    weekdays: number[];
    n: number;
    unit: Unit;
    firstRun: string;
    onceAt: string;
    cron: string;
    tz: string;
    actionType: 'send_template' | 'send_campaign';
    templateId: number | null;
    target: Target;
    campaignId: number | null;
}

const DAYS = ['D', 'L', 'M', 'X', 'J', 'V', 'S']; // 0 = domingo
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const UNIT_S: Record<Unit, number> = { minutes: 60, hours: 3600, days: 86400 };
const UNIT_LABEL: Record<Unit, [string, string]> = { minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['día', 'días'] };

const toLocalInput = (ts: number, tz: string) => { const z = utcToZoned(ts, tz); return `${z.y}-${pad(z.mo)}-${pad(z.d)}T${pad(z.h)}:${pad(z.mi)}`; };
const fromLocalInput = (v: string, tz: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
    return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz) : null;
};

function newDraft(): Draft {
    const tz = DEFAULT_TZ;
    return {
        name: '', enabled: true, mode: 'daily', time: '14:00', weekdays: [1], n: 1, unit: 'days',
        firstRun: toLocalInput(Date.now() + 3600_000, tz), onceAt: toLocalInput(Date.now() + 3600_000, tz), cron: '0 14 * * *', tz,
        actionType: 'send_template', templateId: null, target: { type: 'user', id: '' }, campaignId: null,
    };
}

function draftFromJob(j: Job): Draft {
    const tz = j.timezone || DEFAULT_TZ;
    const d = { ...newDraft(), name: j.name, enabled: j.enabled, tz, actionType: j.actionType, templateId: j.action.templateId ?? null, campaignId: j.action.campaignId ?? null, target: j.action.target ?? { type: 'user', id: '' } as Target };
    if (j.scheduleType === 'cron') {
        d.cron = j.schedule;
        let m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(j.schedule);
        if (m) return { ...d, mode: 'daily', time: `${pad(+m[2])}:${pad(+m[1])}` };
        m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*)$/.exec(j.schedule);
        if (m) return { ...d, mode: 'weekly', time: `${pad(+m[2])}:${pad(+m[1])}`, weekdays: m[3].split(',').map(Number) };
        return { ...d, mode: 'cron' };
    }
    if (j.scheduleType === 'interval') {
        const s = Number(j.schedule);
        const unit: Unit = s % 86400 === 0 ? 'days' : s % 3600 === 0 ? 'hours' : 'minutes';
        return { ...d, mode: 'interval', unit, n: s / UNIT_S[unit], firstRun: toLocalInput(j.startAt ?? Date.now(), tz) };
    }
    return { ...d, mode: 'once', onceAt: toLocalInput(Date.parse(j.schedule), tz) };
}

/** Convierte el borrador del editor en la programación que entiende el servidor. */
function toSpec(d: Draft): { scheduleType: Job['scheduleType']; schedule: string; startAt: number | null; error?: string } {
    switch (d.mode) {
        case 'daily': case 'weekly': {
            const [hh, mm] = d.time.split(':').map(Number);
            if (Number.isNaN(hh) || Number.isNaN(mm)) return { scheduleType: 'cron', schedule: '', startAt: null, error: 'Elige la hora.' };
            if (d.mode === 'weekly' && !d.weekdays.length) return { scheduleType: 'cron', schedule: '', startAt: null, error: 'Elige al menos un día.' };
            const dow = d.mode === 'weekly' ? [...d.weekdays].sort().join(',') : '*';
            return { scheduleType: 'cron', schedule: `${mm} ${hh} * * ${dow}`, startAt: null };
        }
        case 'interval': {
            const first = fromLocalInput(d.firstRun, d.tz);
            if (!first) return { scheduleType: 'interval', schedule: '', startAt: null, error: 'Elige la primera ejecución.' };
            return { scheduleType: 'interval', schedule: String(Math.max(1, Math.round(d.n)) * UNIT_S[d.unit]), startAt: first };
        }
        case 'once': {
            const at = fromLocalInput(d.onceAt, d.tz);
            if (!at) return { scheduleType: 'once', schedule: '', startAt: null, error: 'Elige la fecha y hora.' };
            return { scheduleType: 'once', schedule: new Date(at).toISOString(), startAt: null };
        }
        default:
            return { scheduleType: 'cron', schedule: d.cron.trim(), startAt: null };
    }
}

export function describeSchedule(j: Pick<Job, 'scheduleType' | 'schedule' | 'startAt' | 'timezone'>): string {
    const d = draftFromJob({ ...j, name: '', enabled: true, actionType: 'send_template', action: {}, id: 0, lastRunAt: null, lastStatus: null, lastResult: null, runCount: 0, nextRunAt: null, running: false });
    switch (d.mode) {
        case 'daily': return `Cada día a las ${d.time}`;
        case 'weekly': return `${d.weekdays.map(x => DAY_NAMES[x]).join(', ')} a las ${d.time}`;
        case 'interval': return `Cada ${d.n} ${UNIT_LABEL[d.unit][d.n === 1 ? 0 : 1]}`;
        case 'once': return `Una vez · ${fmtDateTime(Date.parse(j.schedule), j.timezone)}`;
        default: return `Cron: ${j.schedule}`;
    }
}

function TargetText({ t, roles, channels }: { t?: Target; roles: Role[]; channels: Channel[] }) {
    const userLabel = useMemberLabel(t?.type === 'user' ? t.id : '');
    if (!t) return <>—</>;
    switch (t.type) {
        case 'user': return <>{userLabel}</>;
        case 'users': return <>{t.ids.length} usuarios</>;
        case 'role': return <>rol {roles.find(r => r.id === t.id)?.name ?? t.id}</>;
        case 'channel': return <>#{channels.find(c => c.id === t.id)?.name ?? t.id}</>;
        default: return <>todo el servidor</>;
    }
}

export default function Scheduler() {
    const confirm = useConfirm();
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [editing, setEditing] = useState<{ id: number | null; draft: Draft } | null>(null);
    const [, tick] = useState(0);
    const guild = useGuildData();

    const load = useCallback(() => {
        Promise.all([get<Job[]>('/scheduler/jobs'), get<Template[]>('/messages/templates'), get<Campaign[]>('/confirmations/campaigns')])
            .then(([j, t, c]) => { setJobs(j); setTemplates(t); setCampaigns(c); })
            .catch(e => toast.error(errMsg(e)));
    }, []);
    useEffect(() => { load(); const t = setInterval(() => tick(x => x + 1), 30_000); return () => clearInterval(t); }, [load]);
    useLive(e => {
        if (e.type === 'job:updated') setJobs(js => js ? (js.some(j => j.id === e.data.id) ? js.map(j => j.id === e.data.id ? e.data : j) : [...js, e.data]) : js);
        else if (e.type === 'job:deleted') setJobs(js => js?.filter(j => j.id !== e.data.id) ?? js);
    });

    const act = async (fn: () => Promise<unknown>, okMsg?: string) => { try { await fn(); if (okMsg) toast.ok(okMsg); } catch (e) { toast.error(errMsg(e)); } };

    const toggle = (j: Job, enabled: boolean) => act(async () => {
        const updated = await post<Job>(`/scheduler/jobs/${j.id}/enabled`, { enabled });
        setJobs(js => js?.map(x => x.id === updated.id ? updated : x) ?? js);
    }, enabled ? 'Tarea reanudada' : 'Tarea en pausa');
    const runNow = async (j: Job) => {
        if (!(await confirm({ title: 'Ejecutar ahora', message: `¿Ejecutar "${j.name}" ahora mismo? Se enviarán los mensajes a sus destinatarios.`, confirmLabel: 'Ejecutar' }))) return;
        void act(() => post(`/scheduler/jobs/${j.id}/run`), 'Ejecutando…');
    };
    const remove = async (j: Job) => {
        if (!(await confirm({ title: 'Eliminar tarea', message: `¿Eliminar "${j.name}"?`, confirmLabel: 'Eliminar', danger: true }))) return;
        void act(() => del(`/scheduler/jobs/${j.id}`), 'Tarea eliminada');
    };

    const tplName = (id?: number) => templates.find(t => t.id === id)?.name ?? `#${id}`;
    const campName = (id?: number) => campaigns.find(c => c.id === id)?.name ?? `#${id}`;

    return (
        <div className="page">
            <PageHead title="Programación" subtitle="Decide qué se envía y cuándo. Los cambios se aplican al instante, sin reiniciar el bot.">
                <button className="btn primary" onClick={() => setEditing({ id: null, draft: newDraft() })}><Icon name="plus" /> Nueva tarea</button>
            </PageHead>

            {!jobs ? <Spinner /> : jobs.length === 0 ? (
                <div className="card"><Empty title="No hay tareas programadas">Crea una para enviar un mensaje o el formulario de confirmación de forma automática.</Empty></div>
            ) : (
                <div className="stack">
                    {jobs.map(j => (
                        <div key={j.id} className="card job" style={{ opacity: j.enabled ? 1 : .72 }}>
                            <div className="info">
                                <div className="row wrap">
                                    <h2>{j.name}</h2>
                                    {j.running && <span className="badge warn"><Spinner /> Ejecutando</span>}
                                    {!j.enabled && <span className="badge">En pausa</span>}
                                    {j.lastStatus === 'error' && <span className="badge danger">Último intento con error</span>}
                                    {j.lastStatus === 'missed' && <span className="badge warn">Perdida</span>}
                                </div>
                                <div className="muted">
                                    {j.actionType === 'send_template'
                                        ? <>Enviar plantilla <b>{tplName(j.action.templateId)}</b> a <b><TargetText t={j.action.target} roles={guild.roles} channels={guild.channels} /></b></>
                                        : <>Enviar el formulario de <b>{campName(j.action.campaignId)}</b> a los pendientes</>}
                                </div>
                                <div className="when">
                                    <span>🕒 <b>{describeSchedule(j)}</b>{j.timezone ? ` (${j.timezone})` : ''}</span>
                                    <span>Próxima: <b>{j.enabled && j.nextRunAt ? `${fmtDateTime(j.nextRunAt, j.timezone)} · ${fmtRelative(j.nextRunAt)}` : '—'}</b></span>
                                    <span>Última: <b>{j.lastRunAt ? fmtRelative(j.lastRunAt) : 'nunca'}</b></span>
                                    <span>Ejecuciones: <b>{j.runCount}</b></span>
                                </div>
                                {j.lastResult && <div className={`small ${j.lastStatus === 'error' ? '' : 'muted'}`} style={j.lastStatus === 'error' ? { color: 'var(--danger)' } : undefined}>↳ {j.lastResult}</div>}
                            </div>
                            <div className="actions">
                                <Switch checked={j.enabled} onChange={v => toggle(j, v)} label={`Activar ${j.name}`} />
                                <button className="btn sm" onClick={() => runNow(j)} disabled={j.running}><Icon name="play" size={14} /> Ejecutar</button>
                                <button className="btn sm" onClick={() => setEditing({ id: j.id, draft: draftFromJob(j) })}><Icon name="edit" size={14} /> Editar</button>
                                <button className="btn sm danger" onClick={() => remove(j)} aria-label="Eliminar"><Icon name="trash" size={14} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editing && <JobEditor id={editing.id} initial={editing.draft} templates={templates} campaigns={campaigns} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
        </div>
    );
}

function JobEditor({ id, initial, templates, campaigns, onClose, onSaved }: {
    id: number | null; initial: Draft; templates: Template[]; campaigns: Campaign[]; onClose: () => void; onSaved: () => void;
}) {
    const [d, setD] = useState<Draft>(initial);
    const [runs, setRuns] = useState<number[]>([]);
    const [specError, setSpecError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const set = (patch: Partial<Draft>) => setD(x => ({ ...x, ...patch }));
    const spec = useMemo(() => toSpec(d), [d.mode, d.time, d.weekdays, d.n, d.unit, d.firstRun, d.onceAt, d.cron, d.tz]); // eslint-disable-line react-hooks/exhaustive-deps
    const tzOk = validTz(d.tz);

    useEffect(() => {
        if (spec.error || !tzOk) { setRuns([]); setSpecError(spec.error ?? 'Zona horaria no válida'); return; }
        const t = setTimeout(() => {
            post<{ runs: number[] }>('/scheduler/preview', { scheduleType: spec.scheduleType, schedule: spec.schedule, startAt: spec.startAt, timezone: d.tz })
                .then(r => { setRuns(r.runs); setSpecError(null); })
                .catch(e => { setRuns([]); setSpecError(errMsg(e)); });
        }, 250);
        return () => clearTimeout(t);
    }, [spec, d.tz, tzOk]);

    const save = async () => {
        if (!d.name.trim()) return toast.error('Ponle un nombre a la tarea.');
        if (specError) return toast.error(specError);
        if (d.actionType === 'send_template' && (!d.templateId || !targetReady(d.target))) return toast.error('Elige la plantilla y el destinatario.');
        if (d.actionType === 'send_campaign' && !d.campaignId) return toast.error('Elige la campaña.');
        setSaving(true);
        try {
            const body = {
                name: d.name.trim(), enabled: d.enabled, scheduleType: spec.scheduleType, schedule: spec.schedule, startAt: spec.startAt, timezone: d.tz,
                actionType: d.actionType,
                action: d.actionType === 'send_template' ? { templateId: d.templateId, target: d.target } : { campaignId: d.campaignId },
            };
            if (id) await put(`/scheduler/jobs/${id}`, body); else await post('/scheduler/jobs', body);
            toast.ok(id ? 'Tarea actualizada' : 'Tarea creada');
            onSaved();
        } catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    return (
        <Modal title={id ? 'Editar tarea' : 'Nueva tarea programada'} wide onClose={onClose} footer={<>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
        </>}>
            <label className="field">Nombre<input type="text" autoFocus maxLength={80} value={d.name} onChange={e => set({ name: e.target.value })} placeholder="Recordatorio semanal" /></label>

            <div className="stack" style={{ gap: 10 }}>
                <h3>¿Qué se envía?</h3>
                <div className="seg">
                    <button type="button" className={d.actionType === 'send_template' ? 'on' : ''} onClick={() => set({ actionType: 'send_template' })}>Un mensaje (plantilla)</button>
                    <button type="button" className={d.actionType === 'send_campaign' ? 'on' : ''} onClick={() => set({ actionType: 'send_campaign' })}>Formulario de confirmación</button>
                </div>
                {d.actionType === 'send_template' ? (
                    <>
                        <label className="field">Plantilla
                            <select value={d.templateId ?? ''} onChange={e => set({ templateId: e.target.value ? Number(e.target.value) : null })}>
                                <option value="">— Elige una plantilla —</option>
                                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            {templates.length === 0 && <span className="hint">No tienes plantillas. <a href="#/compose" onClick={onClose}>Crea una en "Enviar mensaje"</a>.</span>}
                        </label>
                        <TargetPicker value={d.target} onChange={target => set({ target })} />
                    </>
                ) : (
                    <label className="field">Campaña
                        <select value={d.campaignId ?? ''} onChange={e => set({ campaignId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">— Elige una campaña —</option>
                            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (desactivada)'}</option>)}
                        </select>
                        <span className="hint">Se envía a los miembros pendientes según las reglas de la campaña (roles excluidos, quién ya respondió…). <a href="#/confirmations" onClick={() => go('confirmations')}>Ver campañas</a></span>
                    </label>
                )}
            </div>

            <div className="sep" />
            <div className="stack" style={{ gap: 10 }}>
                <h3>¿Cuándo?</h3>
                <div className="seg">
                    {([['daily', 'Cada día'], ['weekly', 'Días de la semana'], ['interval', 'Cada X tiempo'], ['once', 'Una sola vez'], ['cron', 'Avanzado (cron)']] as Array<[Mode, string]>).map(([m, l]) =>
                        <button key={m} type="button" className={d.mode === m ? 'on' : ''} onClick={() => set({ mode: m })}>{l}</button>)}
                </div>

                {(d.mode === 'daily' || d.mode === 'weekly') && (
                    <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                        {d.mode === 'weekly' && (
                            <div className="weekdays" role="group" aria-label="Días">
                                {[1, 2, 3, 4, 5, 6, 0].map(i => (
                                    <button key={i} type="button" title={DAY_NAMES[i]} className={d.weekdays.includes(i) ? 'on' : ''}
                                        onClick={() => set({ weekdays: d.weekdays.includes(i) ? d.weekdays.filter(x => x !== i) : [...d.weekdays, i] })}>{DAYS[i]}</button>
                                ))}
                            </div>
                        )}
                        <label className="field" style={{ width: 130 }}>A las<input type="time" value={d.time} onChange={e => set({ time: e.target.value })} /></label>
                    </div>
                )}

                {d.mode === 'interval' && (
                    <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                        <label className="field" style={{ width: 90 }}>Cada<input type="number" min={1} value={d.n} onChange={e => set({ n: Math.max(1, Number(e.target.value) || 1) })} /></label>
                        <label className="field" style={{ width: 130 }}>&nbsp;
                            <select value={d.unit} onChange={e => set({ unit: e.target.value as Unit })}><option value="minutes">minutos</option><option value="hours">horas</option><option value="days">días</option></select>
                        </label>
                        <label className="field" style={{ width: 220 }}>Primera ejecución<input type="datetime-local" value={d.firstRun} onChange={e => set({ firstRun: e.target.value })} /></label>
                    </div>
                )}
                {d.mode === 'interval' && <p className="hint" style={{ margin: 0 }}>Se repite siempre a partir de la primera ejecución (p. ej. cada 3 días a las 14:00 empezando mañana). Mínimo 1 minuto.</p>}

                {d.mode === 'once' && <label className="field" style={{ maxWidth: 260 }}>Fecha y hora<input type="datetime-local" value={d.onceAt} onChange={e => set({ onceAt: e.target.value })} /></label>}

                {d.mode === 'cron' && (
                    <label className="field">Expresión cron
                        <input type="text" className="mono" value={d.cron} onChange={e => set({ cron: e.target.value })} placeholder="0 14 * * *" />
                        <span className="hint">minuto hora día-del-mes mes día-de-la-semana · Ej: <code>0 9 * * 1-5</code> = laborables a las 9:00</span>
                    </label>
                )}

                <label className="field" style={{ maxWidth: 260 }}>Zona horaria
                    <input type="text" list="tzlist" value={d.tz} onChange={e => set({ tz: e.target.value })} style={!tzOk ? { borderColor: 'var(--danger)' } : undefined} />
                    <datalist id="tzlist">{['Europe/Madrid', 'Atlantic/Canary', 'Europe/London', 'UTC', 'America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires'].map(z => <option key={z} value={z} />)}</datalist>
                </label>

                <div className="card" style={{ background: 'var(--panel-2)', padding: 12 }}>
                    {specError ? <span style={{ color: 'var(--danger)' }}>⚠ {specError}</span> : runs.length === 0 ? <span className="muted">Sin próximas ejecuciones.</span> : (
                        <>
                            <b className="small">Próximas ejecuciones</b>
                            <ul className="preview-list">{runs.slice(0, 5).map(r => <li key={r}><b>{fmtDateTime(r, d.tz)}</b> · {fmtRelative(r)}</li>)}</ul>
                        </>
                    )}
                </div>
            </div>

            <Check checked={d.enabled} onChange={enabled => set({ enabled })} label="Tarea activa" hint="Si la desactivas queda guardada pero no se ejecuta." />
        </Modal>
    );
}
