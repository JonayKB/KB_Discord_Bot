import { useEffect, useRef, useState } from 'react';
import { del, get, post, put, type EmbedData, type FileInfo, type Msg, type Status, type Target, type Template } from '../api';
import { fmtRelative } from '../format';
import { useLive } from '../live';
import {
    Check, DiscordPreview, EmbedFields, Empty, FileDrop, Icon, Modal, PageHead, TargetPicker, VariableChips,
    errMsg, targetReady, toast, useConfirm, useUploads,
} from '../ui';

interface Progress { batchId: string; total: number; done: number; failed: number; finished: boolean }

const templateFiles = (t: Template): FileInfo[] =>
    t.files.map(f => ({ ...f, isImage: /^image\/(png|jpe?g|gif|webp)$/.test(f.mime) }));

export default function Compose() {
    const confirm = useConfirm();
    const [target, setTarget] = useState<Target>({ type: 'user', id: '' });
    const [content, setContent] = useState('');
    const [embedOn, setEmbedOn] = useState(false);
    const [embed, setEmbed] = useState<EmbedData>({ color: '#5865f2' });
    const up = useUploads();
    const [status, setStatus] = useState<Status | null>(null);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loaded, setLoaded] = useState<Template | null>(null);
    const [sending, setSending] = useState(false);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [saveOpen, setSaveOpen] = useState(false);
    const [tplName, setTplName] = useState('');
    const area = useRef<HTMLTextAreaElement>(null);
    const batchRef = useRef<string | null>(null);

    const loadTemplates = () => get<Template[]>('/messages/templates').then(setTemplates).catch(e => toast.error(errMsg(e)));
    useEffect(() => { void loadTemplates(); get<Status>('/status').then(setStatus).catch(() => undefined); }, []);

    useLive(e => {
        if (e.type !== 'bulk:progress' || e.data?.batchId !== batchRef.current) return;
        const p = e.data as Progress;
        setProgress(p);
        if (p.finished) {
            batchRef.current = null;
            if (p.failed) toast.error(`Envío terminado: ${p.total - p.failed} enviados, ${p.failed} fallidos (revisa el Historial).`);
            else toast.ok(`Envío terminado: ${p.total} mensajes enviados.`);
        }
    });

    const insertVar = (v: string) => {
        const el = area.current;
        if (!el) return setContent(c => c + v);
        const { selectionStart: s, selectionEnd: e } = el;
        const next = content.slice(0, s) + v + content.slice(e);
        setContent(next);
        requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + v.length, s + v.length); });
    };

    const payload = () => ({
        content,
        embed: embedOn && (embed.title || embed.description) ? embed : null,
        fileIds: up.files.map(f => f.id),
    });
    const hasBody = !!(content.trim() || (embedOn && (embed.title || embed.description)) || up.files.length);

    const audience = async (): Promise<number> => {
        if (target.type === 'users') return target.ids.length;
        if (target.type === 'all' || target.type === 'role') {
            const r = await get<{ count: number }>(`/messages/audience?type=${target.type}${target.type === 'role' ? `&id=${target.id}` : ''}`);
            return r.count;
        }
        return 1;
    };

    const send = async () => {
        if (!targetReady(target)) return toast.error('Elige a quién quieres enviarlo.');
        if (!hasBody) return toast.error('Escribe un texto, añade un embed o adjunta una imagen.');
        setSending(true);
        try {
            const n = await audience();
            if (n > 1) {
                const secs = Math.ceil(n * 1.1);
                const ok = await confirm({
                    title: `Enviar a ${n} personas`,
                    message: <>Se enviará un mensaje privado a <b>{n}</b> miembros, uno cada ~1 segundo para respetar los límites de Discord (≈ {secs < 90 ? `${secs} s` : `${Math.ceil(secs / 60)} min`}). Puedes seguir usando el panel mientras tanto.</>,
                    confirmLabel: 'Enviar',
                });
                if (!ok) return;
            }
            const res = await post<Msg | { batchId: string; total: number }>('/messages/send', { target, payload: payload() });
            if ('batchId' in res) {
                batchRef.current = res.batchId;
                setProgress({ batchId: res.batchId, total: res.total, done: 0, failed: 0, finished: false });
            } else if (res.status === 'failed') {
                return toast.error(`No se pudo enviar: ${res.error}`);
            } else {
                toast.ok(res.kind === 'channel' ? `Enviado a #${res.channelName ?? 'canal'}` : `Enviado a ${res.userTag ?? 'usuario'}`);
            }
            setContent(''); setEmbed({ color: '#5865f2' }); setEmbedOn(false); up.clear(); setLoaded(null);
        } catch (e) {
            toast.error(errMsg(e));
        } finally {
            setSending(false);
        }
    };

    const loadTemplate = (t: Template) => {
        setContent(t.content);
        setEmbedOn(!!t.embed);
        setEmbed(t.embed ?? { color: '#5865f2' });
        up.setFiles(templateFiles(t));
        setLoaded(t);
        toast.info(`Plantilla "${t.name}" cargada`);
    };

    const saveTemplate = async (asUpdate: boolean) => {
        const name = asUpdate && loaded ? loaded.name : tplName.trim();
        if (!name) return toast.error('Ponle un nombre a la plantilla.');
        try {
            const body = { name, content, embed: payload().embed, fileIds: up.files.map(f => f.id) };
            const saved = asUpdate && loaded ? await put<Template>(`/messages/templates/${loaded.id}`, body) : await post<Template>('/messages/templates', body);
            setLoaded(saved); setSaveOpen(false); setTplName('');
            toast.ok(asUpdate ? 'Plantilla actualizada' : 'Plantilla guardada');
            void loadTemplates();
        } catch (e) { toast.error(errMsg(e)); }
    };

    const removeTemplate = async (t: Template) => {
        if (!(await confirm({ title: 'Eliminar plantilla', message: `¿Eliminar "${t.name}"?`, confirmLabel: 'Eliminar', danger: true }))) return;
        try { await del(`/messages/templates/${t.id}`); if (loaded?.id === t.id) setLoaded(null); void loadTemplates(); }
        catch (e) { toast.error(errMsg(e)); }
    };

    const pct = progress ? Math.round((progress.done / Math.max(progress.total, 1)) * 100) : 0;
    return (
        <div className="page">
            <PageHead title="Enviar mensaje" subtitle="Texto, embeds e imágenes a un usuario, varios, un rol, todo el servidor o un canal." />

            {progress && (
                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="row between" style={{ marginBottom: 8 }}>
                        <b>{progress.finished ? 'Envío terminado' : 'Enviando…'}</b>
                        <span className="muted">{progress.done}/{progress.total}{progress.failed ? ` · ${progress.failed} fallidos` : ''}</span>
                    </div>
                    <div className="progress"><div style={{ width: `${pct}%`, background: progress.failed ? 'var(--warn)' : undefined }} /></div>
                    {progress.finished && <div className="row" style={{ marginTop: 10 }}><button className="btn sm" onClick={() => setProgress(null)}>Cerrar</button></div>}
                </div>
            )}

            <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 320px', alignItems: 'start' }}>
                <div className="stack">
                    <div className="card stack">
                        <h2>1 · Destinatario</h2>
                        <TargetPicker value={target} onChange={setTarget} memberCount={status?.guild?.memberCount} />
                    </div>

                    <div className="card stack">
                        <div className="row between"><h2>2 · Mensaje</h2>{loaded && <span className="badge accent">Plantilla: {loaded.name}</span>}</div>
                        <label className="field">Texto
                            <textarea ref={area} value={content} maxLength={2000} placeholder="Escribe el mensaje… (puedes pegar imágenes con Ctrl+V)" rows={5}
                                onChange={e => setContent(e.target.value)} onPaste={up.onPaste} />
                            <span className="hint">{content.length}/2000</span>
                        </label>
                        <VariableChips onInsert={insertVar} />
                        <Check checked={embedOn} onChange={setEmbedOn} label="Añadir un embed (tarjeta con título y color)" />
                        {embedOn && <EmbedFields value={embed} onChange={setEmbed} />}
                        <FileDrop up={up} />
                    </div>

                    <div className="card stack">
                        <h2>Vista previa</h2>
                        <DiscordPreview botName={status?.bot?.tag ?? 'Bot'} botAvatar={status?.bot?.avatar} content={content} embed={embedOn ? embed : null} files={up.files} />
                        <div className="row wrap">
                            <button className="btn primary" disabled={sending || up.uploading} onClick={send}><Icon name="send" /> {sending ? 'Enviando…' : 'Enviar ahora'}</button>
                            <button className="btn" disabled={!hasBody} onClick={() => setSaveOpen(true)}>Guardar como plantilla</button>
                            {loaded && <button className="btn" disabled={!hasBody} onClick={() => saveTemplate(true)}>Actualizar "{loaded.name}"</button>}
                        </div>
                    </div>
                </div>

                <div className="card stack" style={{ position: 'sticky', top: 0 }}>
                    <h2>Plantillas</h2>
                    {templates.length === 0 ? <Empty title="Sin plantillas">Guarda un mensaje para reutilizarlo o programarlo.</Empty> : (
                        <div className="stack" style={{ gap: 8 }}>
                            {templates.map(t => (
                                <div key={t.id} className="card" style={{ padding: 10, background: loaded?.id === t.id ? 'var(--accent-soft)' : 'var(--panel-2)' }}>
                                    <div className="row between"><b className="ellipsis">{t.name}</b><span className="muted small nowrap">{fmtRelative(t.updatedAt)}</span></div>
                                    <div className="muted small ellipsis" style={{ margin: '2px 0 8px' }}>{t.content || t.embed?.title || '(solo adjuntos)'}</div>
                                    <div className="row"><button className="btn sm" onClick={() => loadTemplate(t)}>Cargar</button><button className="btn sm danger" onClick={() => removeTemplate(t)} aria-label="Eliminar"><Icon name="trash" size={14} /></button></div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {saveOpen && (
                <Modal title="Guardar plantilla" onClose={() => setSaveOpen(false)} footer={<>
                    <button className="btn" onClick={() => setSaveOpen(false)}>Cancelar</button>
                    <button className="btn primary" onClick={() => saveTemplate(false)}>Guardar</button>
                </>}>
                    <label className="field">Nombre<input type="text" autoFocus maxLength={80} value={tplName} onChange={e => setTplName(e.target.value)} onKeyDown={e => e.key === 'Enter' && saveTemplate(false)} placeholder="Recordatorio semanal" /></label>
                    <p className="hint">Podrás usarla desde Programación para enviarla automáticamente.</p>
                </Modal>
            )}
        </div>
    );
}
