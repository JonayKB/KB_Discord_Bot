import { useEffect, useState } from 'react';
import { get, post, put, type ModuleInfo, type NewsState } from '../api';
import { useLive } from '../live';
import { ChannelSelect, Empty, PageHead, Spinner, errMsg, toast, useGuildData } from '../ui';

export default function News() {
    const guild = useGuildData();
    const [state, setState] = useState<NewsState | null>(null);
    const [channelId, setChannelId] = useState('');
    const [mod, setMod] = useState<ModuleInfo | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        get<NewsState>('/news').then(s => { setState(s); setChannelId(s.config.channelId ?? ''); }).catch(e => toast.error(errMsg(e)));
        get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'news') ?? null)).catch(() => undefined);
    }, []);
    useLive(e => {
        if (e.type === 'news:published') setState(e.data as NewsState);
        if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'news') ?? null);
    });

    if (!state) return <div className="page"><Spinner /></div>;
    const running = mod?.running ?? true;
    const dirty = channelId !== (state.config.channelId ?? '');

    const run = async (action: () => Promise<NewsState>) => {
        setBusy(true);
        try {
            const next = await action();
            setState(next);
            if (next.lastError) toast.error(next.lastError);
            else toast.ok('Noticias publicadas');
        } catch (e) { toast.error(errMsg(e)); }
        finally { setBusy(false); }
    };

    return (
        <div className="page">
            <PageHead title="Noticias" subtitle="Los últimos mensajes de un canal, publicados en un fichero público para el launcher.">
                <button className="btn" disabled={!running || busy || dirty} onClick={() => run(() => post<NewsState>('/news/publish'))}>Publicar ahora</button>
                <button className="btn primary" disabled={!running || busy || !dirty} onClick={() => run(() => put<NewsState>('/news', { channelId }))}>Guardar</button>
            </PageHead>

            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Noticias</b> está desactivado: el fichero se queda como está y no se actualiza. Actívalo en <a href="#/modules">Módulos</a>.</div>}
            {state.lastError && <div className="alert" style={{ marginBottom: 16 }}>La última publicación falló y se mantiene el fichero anterior: {state.lastError}</div>}

            <div className="stack">
                <div className="card stack">
                    <h2>Canal</h2>
                    <label className="field">Canal de noticias<ChannelSelect value={channelId} channels={guild.channels} onChange={setChannelId} /></label>
                    <div className="hint">Todo lo que se escriba en este canal será público: el fichero se puede leer sin estar en el Discord.</div>
                </div>

                <div className="card stack">
                    <h2>Publicado</h2>
                    {state.feed?.updatedAt && <div className="hint">Actualizado: {new Date(state.feed.updatedAt).toLocaleString()}</div>}
                    {!state.feed?.messages.length && <Empty title="Sin noticias publicadas" />}
                    {state.feed?.messages.map(m => (
                        <div key={m.id}>
                            <div className="row between wrap">
                                <b>{m.author.name}</b>
                                <span className="muted small">{new Date(m.createdAt).toLocaleString()}</span>
                            </div>
                            {m.content && <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>}
                            <div className="row wrap">
                                {m.images.length > 0 && <span className="badge">{m.images.length === 1 ? '1 imagen' : `${m.images.length} imágenes`}</span>}
                                {m.poll && <span className="badge accent">Encuesta: {m.poll.question}</span>}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
