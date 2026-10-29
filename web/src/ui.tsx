import {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
    type ChangeEvent, type DragEvent, type ReactNode,
} from 'react';
import { get, uploadFiles, type Channel, type EmbedData, type FileInfo, type Member, type Role, type Target } from './api';
import { fmtSize } from './format';

// ───────────────────────────── Iconos ─────────────────────────────

const PATHS: Record<string, ReactNode> = {
    home: <><path d="M3 12l9-9 9 9" /><path d="M5 10v10h5v-6h4v6h5V10" /></>,
    send: <><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></>,
    inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
    check: <><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    terminal: <><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></>,
    play: <><path d="M6 4l14 8-14 8z" /></>,
    paperclip: <><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></>,
    refresh: <><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></>,
    back: <><path d="M15 18l-6-6 6-6" /></>,
    logout: <><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>,
    search: <><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></>,
    chart: <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>,
    wave: <><path d="M7 11V6a2 2 0 014 0v5" /><path d="M11 10V4a2 2 0 014 0v6" /><path d="M15 10V6a2 2 0 014 0v8a7 7 0 01-7 7h-1a7 7 0 01-6-3.5L3 14a2 2 0 013.4-2L8 14" /></>,
    smile: <><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" /></>,
    server: <><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></>,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {PATHS[name]}
        </svg>
    );
}

// ───────────────────────────── Básicos ─────────────────────────────

export function Avatar({ src, name, size }: { src?: string | null; name?: string | null; size?: 'sm' | 'lg' }) {
    const cls = `avatar ${size ?? ''}`;
    const [failed, setFailed] = useState(false);
    if (src && !failed) return <img className={cls} src={src} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer" />;
    return <div className={cls}>{(name ?? '?').slice(0, 1).toUpperCase()}</div>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
    return (
        <span className="switch">
            <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
            <i />
        </span>
    );
}

export function Spinner() { return <span className="spinner" role="status" aria-label="Cargando" />; }

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
    return <div className="empty"><b>{title}</b>{children}</div>;
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
    return (
        <div className="page-head">
            <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
            {children && <div className="row wrap">{children}</div>}
        </div>
    );
}

export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
    return (
        <label className="check">
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
            <span>{label}{hint && <span className="hint">{hint}</span>}</span>
        </label>
    );
}

// ───────────────────────────── Modal ─────────────────────────────

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-head"><h2>{title}</h2><button className="btn ghost icon" onClick={onClose} aria-label="Cerrar">✕</button></div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-foot">{footer}</div>}
            </div>
        </div>
    );
}

// ───────────────────────────── Toasts ─────────────────────────────

interface ToastItem { id: number; kind: 'ok' | 'error' | 'info'; text: string }
const toastListeners = new Set<(t: ToastItem) => void>();
let toastId = 0;
const pushToast = (kind: ToastItem['kind'], text: string) => toastListeners.forEach(fn => fn({ id: ++toastId, kind, text }));

export const toast = {
    ok: (t: string) => pushToast('ok', t),
    error: (t: string) => pushToast('error', t),
    info: (t: string) => pushToast('info', t),
};

export function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function Toasts() {
    const [items, setItems] = useState<ToastItem[]>([]);
    useEffect(() => {
        const fn = (t: ToastItem) => {
            setItems(x => [...x.slice(-3), t]);
            setTimeout(() => setItems(x => x.filter(i => i.id !== t.id)), t.kind === 'error' ? 7000 : 4000);
        };
        toastListeners.add(fn);
        return () => { toastListeners.delete(fn); };
    }, []);
    return <div className="toasts" aria-live="polite">{items.map(i => <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>)}</div>;
}

// ───────────────────────────── Confirmación ─────────────────────────────

interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
    const ask = useCallback((opts: ConfirmOpts) => new Promise<boolean>(resolve => setState({ opts, resolve })), []);
    const close = (v: boolean) => { state?.resolve(v); setState(null); };
    return (
        <ConfirmCtx.Provider value={ask}>
            {children}
            {state && (
                <Modal title={state.opts.title} onClose={() => close(false)} footer={<>
                    <button className="btn" onClick={() => close(false)}>Cancelar</button>
                    <button className={`btn ${state.opts.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => close(true)}>{state.opts.confirmLabel ?? 'Aceptar'}</button>
                </>}>
                    <div>{state.opts.message}</div>
                </Modal>
            )}
        </ConfirmCtx.Provider>
    );
}

// ───────────────────────────── Lightbox y adjuntos ─────────────────────────────

export function Attachments({ files, className }: { files: FileInfo[]; className?: string }) {
    const [open, setOpen] = useState<string | null>(null);
    if (!files.length) return null;
    return (
        <>
            {files.map(f => f.isImage
                ? <img key={f.id} className={className ?? 'att'} src={f.url} alt={f.name} loading="lazy" onClick={() => setOpen(f.url)} />
                : <a key={f.id} className="file-link" href={f.url} target="_blank" rel="noreferrer" download={f.name}>📎 {f.name} <span className="muted">({fmtSize(f.size)})</span></a>)}
            {open && <div className="lightbox" onClick={() => setOpen(null)}><img src={open} alt="" /></div>}
        </>
    );
}

// ───────────────────────────── Subida de archivos ─────────────────────────────

export function useUploads(initial: FileInfo[] = []) {
    const [files, setFiles] = useState<FileInfo[]>(initial);
    const [uploading, setUploading] = useState(false);

    const add = useCallback(async (list: FileList | File[] | null | undefined) => {
        const arr = Array.from(list ?? []);
        if (!arr.length) return;
        if (files.length + arr.length > 10) { toast.error('Discord admite como máximo 10 archivos por mensaje.'); return; }
        setUploading(true);
        try {
            const up = await uploadFiles(arr);
            setFiles(f => [...f, ...up]);
        } catch (e) {
            toast.error(errMsg(e));
        } finally {
            setUploading(false);
        }
    }, [files.length]);

    const remove = (id: string) => setFiles(f => f.filter(x => x.id !== id));
    const clear = () => setFiles([]);

    /** Para usar en onPaste de un textarea: sube las imágenes pegadas. */
    const onPaste = (e: React.ClipboardEvent) => {
        const imgs = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'));
        if (imgs.length) { e.preventDefault(); void add(imgs); }
    };

    return { files, setFiles, uploading, add, remove, clear, onPaste };
}

export function FileDrop({ up, compact }: { up: ReturnType<typeof useUploads>; compact?: boolean }) {
    const [over, setOver] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void up.add(e.dataTransfer.files); };
    return (
        <div className={`drop ${over ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
            {up.files.map(f => (
                <div className="thumb" key={f.id} title={f.name}>
                    {f.isImage ? <img src={f.url} alt={f.name} /> : <span>📎 {f.name.slice(0, 14)}</span>}
                    <button type="button" onClick={() => up.remove(f.id)} aria-label={`Quitar ${f.name}`}>×</button>
                </div>
            ))}
            {up.uploading && <Spinner />}
            <input ref={input} type="file" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void up.add(e.target.files); e.target.value = ''; }} />
            <button type="button" className="btn sm" onClick={() => input.current?.click()}><Icon name="paperclip" /> {compact ? 'Adjuntar' : 'Añadir imágenes o archivos'}</button>
            {!compact && !up.files.length && <span className="hint">Arrastra aquí o pega una imagen (Ctrl+V) en el texto.</span>}
        </div>
    );
}

// ───────────────────────────── Selector de usuarios ─────────────────────────────

const memberCache = new Map<string, Member>();
export const rememberMember = (m: Member) => memberCache.set(m.id, m);

export function UserPicker({ onPick, placeholder, exclude = [] }: { onPick: (m: Member) => void; placeholder?: string; exclude?: string[] }) {
    const [q, setQ] = useState('');
    const [items, setItems] = useState<Member[]>([]);
    const [open, setOpen] = useState(false);
    const [hi, setHi] = useState(0);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => {
            get<Member[]>(`/guild/members?q=${encodeURIComponent(q)}`).then(r => { setItems(r.filter(m => !exclude.includes(m.id))); setHi(0); }).catch(() => setItems([]));
        }, 180);
        return () => clearTimeout(t);
    }, [q, open, exclude.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, []);

    const pick = (m: Member) => { rememberMember(m); onPick(m); setQ(''); setOpen(false); };
    return (
        <div className="picker" ref={box}>
            <input type="search" value={q} placeholder={placeholder ?? 'Buscar usuario por nombre…'} onFocus={() => setOpen(true)}
                onChange={e => { setQ(e.target.value); setOpen(true); }}
                onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, items.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
                    else if (e.key === 'Enter' && items[hi]) { e.preventDefault(); pick(items[hi]); }
                    else if (e.key === 'Escape') setOpen(false);
                }} />
            {open && (
                <div className="picker-list">
                    {items.length === 0 && <div className="picker-item muted">Sin resultados</div>}
                    {items.map((m, i) => (
                        <div key={m.id} className={`picker-item ${i === hi ? 'hi' : ''}`} onMouseDown={e => { e.preventDefault(); pick(m); }} onMouseEnter={() => setHi(i)}>
                            <Avatar src={m.avatar} name={m.displayName} size="sm" />
                            <span className="grow ellipsis"><b>{m.displayName}</b> <span className="muted">@{m.username}</span></span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Muestra el nombre de un usuario conocido por ID (con caché). */
export function useMemberLabel(id: string): string {
    const [label, setLabel] = useState(memberCache.get(id)?.displayName ?? id);
    useEffect(() => {
        if (!id) return;
        const cached = memberCache.get(id);
        if (cached) { setLabel(cached.displayName); return; }
        get<Member[]>(`/guild/members?q=${encodeURIComponent(id)}`).then(r => {
            const m = r.find(x => x.id === id);
            if (m) { rememberMember(m); setLabel(m.displayName); }
        }).catch(() => undefined);
    }, [id]);
    return label;
}

function UserChip({ id, onRemove }: { id: string; onRemove: () => void }) {
    const label = useMemberLabel(id);
    return <span className="chip">{label}<button type="button" onClick={onRemove} aria-label="Quitar">×</button></span>;
}

// ───────────────────────────── Datos del servidor ─────────────────────────────

export function useGuildData() {
    const [roles, setRoles] = useState<Role[]>([]);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        Promise.all([get<Role[]>('/guild/roles'), get<Channel[]>('/guild/channels')])
            .then(([r, c]) => { setRoles(r); setChannels(c); })
            .catch(e => setError(errMsg(e)));
    }, []);
    return { roles, channels, error };
}

export function RoleSelect({ value, onChange, roles, empty }: { value: string | null; onChange: (v: string | null) => void; roles: Role[]; empty?: string }) {
    return (
        <select value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
            <option value="">{empty ?? '— Ninguno —'}</option>
            {roles.filter(r => !r.managed).map(r => <option key={r.id} value={r.id}>{r.name} ({r.members})</option>)}
        </select>
    );
}

export function ChannelSelect({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: Channel[] }) {
    return (
        <select value={value} onChange={e => onChange(e.target.value)}>
            <option value="">— Elige un canal —</option>
            {channels.map(c => <option key={c.id} value={c.id}>#{c.name}{c.category ? `  ·  ${c.category}` : ''}</option>)}
        </select>
    );
}

export function RoleChecklist({ label, hint, roles, value, onChange }: {
    label: string; hint?: string; roles: Role[]; value: string[]; onChange: (v: string[]) => void;
}) {
    const toggle = (id: string) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
    return (
        <div className="field">
            <span>{label}</span>
            <div className="card" style={{ background: 'var(--panel-2)', padding: 10, maxHeight: 150, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 6 }}>
                {roles.filter(r => !r.managed).map(r => (
                    <label key={r.id} className="check" style={{ fontWeight: 450 }}><input type="checkbox" checked={value.includes(r.id)} onChange={() => toggle(r.id)} /> {r.name} <span className="muted small">({r.members})</span></label>
                ))}
                {roles.length === 0 && <span className="hint">Cargando roles…</span>}
            </div>
            {hint && <span className="hint">{hint}</span>}
        </div>
    );
}

// ───────────────────────────── Selector de destinatario ─────────────────────────────

export function TargetPicker({ value, onChange, allowChannel = true, memberCount }: {
    value: Target; onChange: (t: Target) => void; allowChannel?: boolean; memberCount?: number;
}) {
    const { roles, channels } = useGuildData();
    const kinds = useMemo(() => [
        ['user', 'Un usuario'], ['users', 'Varios usuarios'], ['role', 'Un rol'], ['all', 'Todo el servidor'],
        ...(allowChannel ? [['channel', 'Un canal']] : []),
    ] as Array<[Target['type'], string]>, [allowChannel]);

    const switchType = (type: Target['type']) => {
        if (type === value.type) return;
        if (type === 'user') onChange({ type, id: '' });
        else if (type === 'users') onChange({ type, ids: value.type === 'user' && value.id ? [value.id] : [] });
        else if (type === 'role') onChange({ type, id: '' });
        else if (type === 'channel') onChange({ type, id: '' });
        else onChange({ type: 'all' });
    };

    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="seg" role="tablist">
                {kinds.map(([k, label]) => <button key={k} type="button" className={value.type === k ? 'on' : ''} onClick={() => switchType(k)}>{label}</button>)}
            </div>

            {value.type === 'user' && (
                value.id
                    ? <div><UserChip id={value.id} onRemove={() => onChange({ type: 'user', id: '' })} /></div>
                    : <UserPicker onPick={m => onChange({ type: 'user', id: m.id })} />
            )}
            {value.type === 'users' && (
                <>
                    <div className="row wrap">{value.ids.map(id => <UserChip key={id} id={id} onRemove={() => onChange({ type: 'users', ids: value.ids.filter(x => x !== id) })} />)}</div>
                    <UserPicker exclude={value.ids} placeholder="Añadir usuario…" onPick={m => onChange({ type: 'users', ids: [...value.ids, m.id] })} />
                </>
            )}
            {value.type === 'role' && (
                <select value={value.id} onChange={e => onChange({ type: 'role', id: e.target.value })}>
                    <option value="">— Elige un rol —</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.name} ({r.members} miembros)</option>)}
                </select>
            )}
            {value.type === 'all' && <div className="hint">Se enviará un MD a cada miembro humano del servidor{memberCount ? ` (${memberCount})` : ''}. Los bots se omiten.</div>}
            {value.type === 'channel' && <ChannelSelect value={value.id} channels={channels} onChange={id => onChange({ type: 'channel', id })} />}
        </div>
    );
}

export function targetReady(t: Target): boolean {
    switch (t.type) {
        case 'user': case 'role': case 'channel': return !!t.id;
        case 'users': return t.ids.length > 0;
        default: return true;
    }
}

// ───────────────────────────── Editor de embed ─────────────────────────────

export function EmbedFields({ value, onChange }: { value: EmbedData; onChange: (e: EmbedData) => void }) {
    const set = (patch: Partial<EmbedData>) => onChange({ ...value, ...patch });
    return (
        <div className="stack" style={{ gap: 10 }}>
            <div className="row">
                <label className="field grow">Título<input type="text" maxLength={256} value={value.title ?? ''} onChange={e => set({ title: e.target.value })} /></label>
                <label className="field">Color<input type="color" value={value.color || '#5865f2'} onChange={e => set({ color: e.target.value })} /></label>
            </div>
            <label className="field">Descripción<textarea maxLength={4000} value={value.description ?? ''} onChange={e => set({ description: e.target.value })} /></label>
            <label className="field">Pie<input type="text" maxLength={200} value={value.footer ?? ''} onChange={e => set({ footer: e.target.value })} /></label>
        </div>
    );
}

export const VARIABLES: Array<[string, string]> = [
    ['{user}', 'Nombre visible'], ['{username}', 'Usuario'], ['{mention}', 'Mención'], ['{server}', 'Servidor'], ['{count}', 'Nº de miembros'],
];

export function VariableChips({ onInsert }: { onInsert: (v: string) => void }) {
    return (
        <div className="row wrap" style={{ gap: 6 }}>
            <span className="hint">Variables:</span>
            {VARIABLES.map(([v, d]) => <button type="button" key={v} className="var-chip" title={d} onClick={() => onInsert(v)}>{v}</button>)}
        </div>
    );
}

// ───────────────────────────── Vista previa tipo Discord ─────────────────────────────

export function DiscordPreview({ botName, botAvatar, content, embed, files }: {
    botName: string; botAvatar?: string | null; content: string; embed: EmbedData | null; files: FileInfo[];
}) {
    const sample = (s: string) => s.replaceAll('{user}', 'Alex').replaceAll('{username}', 'alex_01').replaceAll('{mention}', '@Alex').replaceAll('{server}', 'Tu servidor').replaceAll('{count}', '128');
    return (
        <div className="dc">
            <div className="dc-head"><Avatar src={botAvatar} name={botName} size="lg" /><div><b>{botName}</b> <small>BOT · hoy</small></div></div>
            {content.trim() && <div className="dc-text">{sample(content)}</div>}
            {embed && (embed.title || embed.description) && (
                <div className="dc-embed" style={{ borderLeftColor: embed.color || '#5865f2' }}>
                    {embed.title && <div className="t">{sample(embed.title)}</div>}
                    {embed.description && <div className="d">{sample(embed.description)}</div>}
                    {embed.footer && <div className="f">{sample(embed.footer)}</div>}
                </div>
            )}
            {files.length > 0 && <div className="dc-files">{files.map(f => f.isImage ? <img key={f.id} src={f.url} alt={f.name} /> : <span key={f.id}>📎 {f.name}</span>)}</div>}
            {!content.trim() && !embed?.title && !embed?.description && !files.length && <div className="dc-text muted">La vista previa aparecerá aquí…</div>}
        </div>
    );
}
