import { useEffect, useRef, useState } from 'react';
import { get, post, put, type EmbedData, type ModuleInfo, type Status, type WelcomeConfig, type WelcomeMessage } from '../api';
import { useLive } from '../live';
import { Check, ChannelSelect, DiscordPreview, EmbedFields, Icon, PageHead, RoleChecklist, Spinner, Switch, VariableChips, errMsg, toast, useGuildData } from '../ui';

type Kind = 'dm' | 'channel' | 'goodbye';

const SECTIONS: Array<{ kind: Kind; title: string; hint: string }> = [
    { kind: 'dm', title: 'Mensaje directo al entrar', hint: 'Le llega por MD a cada nuevo miembro (si tiene los MD abiertos).' },
    { kind: 'channel', title: 'Mensaje en un canal al entrar', hint: 'Se publica en el canal que elijas; usa {mention} para mencionarle.' },
    { kind: 'goodbye', title: 'Despedida al salir', hint: 'Se publica en un canal cuando alguien se va del servidor.' },
];

export default function Welcome() {
    const guild = useGuildData();
    const [cfg, setCfg] = useState<WelcomeConfig | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [mod, setMod] = useState<ModuleInfo | null>(null);

    useEffect(() => {
        get<WelcomeConfig>('/welcome').then(setCfg).catch(e => toast.error(errMsg(e)));
        get<Status>('/status').then(setStatus).catch(() => undefined);
        get<ModuleInfo[]>('/modules').then(m => setMod(m.find(x => x.id === 'welcome') ?? null)).catch(() => undefined);
    }, []);
    useLive(e => { if (e.type === 'modules:changed') setMod((e.data as ModuleInfo[]).find(x => x.id === 'welcome') ?? null); });

    if (!cfg) return <div className="page"><Spinner /></div>;
    const running = mod?.running ?? true;
    const set = (patch: Partial<WelcomeConfig>) => { setCfg({ ...cfg, ...patch }); setDirty(true); };
    const setMsg = (kind: Kind, patch: Partial<WelcomeMessage>) => set({ [kind]: { ...cfg[kind], ...patch } } as Partial<WelcomeConfig>);

    const save = async () => {
        setSaving(true);
        try { setCfg(await put<WelcomeConfig>('/welcome', cfg)); setDirty(false); toast.ok('Bienvenida guardada'); }
        catch (e) { toast.error(errMsg(e)); }
        finally { setSaving(false); }
    };

    const test = async (kind: Kind) => {
        try {
            await post('/welcome/test', { kind, config: cfg });
            toast.ok(kind === 'dm' ? 'Te he enviado la prueba por MD' : 'Prueba publicada en el canal');
        } catch (e) { toast.error(errMsg(e)); }
    };

    return (
        <div className="page">
            <PageHead title="Bienvenida" subtitle="Qué recibe cada persona al entrar al servidor y qué pasa cuando se va.">
                {dirty && <span className="muted small">Cambios sin guardar</span>}
                <button className="btn primary" disabled={!running || saving || !dirty} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</button>
            </PageHead>

            {!running && <div className="alert" style={{ marginBottom: 16 }}>El módulo <b>Bienvenida</b> está desactivado: no se envía nada al entrar ni al salir. Actívalo en <a href="#/modules">Módulos</a>.</div>}

            <div className="stack">
                {SECTIONS.map(sec => (
                    <MessageCard key={sec.kind} title={sec.title} hint={sec.hint} kind={sec.kind} msg={cfg[sec.kind]} channels={guild.channels}
                        botName={status?.bot?.tag ?? 'Bot'} botAvatar={status?.bot?.avatar} running={running}
                        onChange={patch => setMsg(sec.kind, patch)} onTest={() => test(sec.kind)} />
                ))}

                <div className="card stack">
                    <h2>Al entrar</h2>
                    <RoleChecklist label="Roles automáticos" hint="Se dan a cada nuevo miembro en cuanto entra (p. ej. «Sin verificar» o «Miembro»)."
                        roles={guild.roles} value={cfg.autoRoleIds} onChange={autoRoleIds => set({ autoRoleIds })} />
                    <Check checked={cfg.ignoreBots} onChange={ignoreBots => set({ ignoreBots })} label="Ignorar a los bots" hint="No se les da la bienvenida, ni roles, ni despedida." />
                </div>
            </div>
        </div>
    );
}

function MessageCard({ title, hint, kind, msg, channels, botName, botAvatar, running, onChange, onTest }: {
    title: string; hint: string; kind: Kind; msg: WelcomeMessage; channels: ReturnType<typeof useGuildData>['channels'];
    botName: string; botAvatar?: string | null; running: boolean;
    onChange: (patch: Partial<WelcomeMessage>) => void; onTest: () => void;
}) {
    const area = useRef<HTMLTextAreaElement>(null);
    const content = msg.payload.content ?? '';
    const embed = msg.payload.embed ?? null;
    const setPayload = (patch: Partial<WelcomeMessage['payload']>) => onChange({ payload: { ...msg.payload, ...patch } });
    const setEmbed = (e: EmbedData | null) => setPayload({ embed: e });

    const insertVar = (v: string) => {
        const el = area.current;
        if (!el) return setPayload({ content: content + v });
        const [a, b] = [el.selectionStart, el.selectionEnd];
        setPayload({ content: content.slice(0, a) + v + content.slice(b) });
        requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + v.length, a + v.length); });
    };

    return (
        <div className="card stack">
            <div className="row between wrap">
                <div><h2>{title}</h2><div className="hint">{hint}</div></div>
                <div className="row">
                    <button className="btn sm" disabled={!running} onClick={onTest} title={kind === 'dm' ? 'Te lo envía a ti por MD' : 'Lo publica en el canal como si acabaras de entrar'}><Icon name="send" size={14} /> Probar</button>
                    <Switch checked={msg.enabled} onChange={enabled => onChange({ enabled })} label={`Activar: ${title}`} />
                </div>
            </div>

            {msg.enabled && (
                <div className="grid cols-2" style={{ alignItems: 'start' }}>
                    <div className="stack">
                        {kind !== 'dm' && <label className="field">Canal<ChannelSelect value={msg.channelId ?? ''} channels={channels} onChange={channelId => onChange({ channelId: channelId || null })} /></label>}
                        <label className="field">Texto
                            <textarea ref={area} rows={3} maxLength={2000} value={content} onChange={e => setPayload({ content: e.target.value })} />
                        </label>
                        <VariableChips onInsert={insertVar} />
                        <Check checked={!!embed} onChange={on => setEmbed(on ? { title: '¡Bienvenido!', description: '', color: '#5865F2' } : null)} label="Añadir un embed" />
                        {embed && (
                            <>
                                <EmbedFields value={embed} onChange={setEmbed} />
                                <Check checked={embed.thumbnail === '{avatar}'} onChange={on => setEmbed({ ...embed, thumbnail: on ? '{avatar}' : undefined })} label="Miniatura con el avatar del usuario" />
                            </>
                        )}
                    </div>
                    <DiscordPreview botName={botName} botAvatar={botAvatar} content={content} embed={embed} files={[]} />
                </div>
            )}
        </div>
    );
}
