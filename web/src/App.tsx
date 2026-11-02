import { useCallback, useEffect, useState } from 'react';
import { useHash } from './nav';
import { get, type Me } from './api';
import { AccessContext } from './access';
import { startLive, stopLive, useLive, useLiveConnected } from './live';
import { Avatar, ConfirmProvider, Icon, Spinner, Toasts } from './ui';
import Dashboard from './pages/Dashboard';
import Compose from './pages/Compose';
import Inbox from './pages/Inbox';
import History from './pages/History';
import Scheduler from './pages/Scheduler';
import Confirmations from './pages/Confirmations';
import Servers from './pages/Servers';
import Reactions from './pages/Reactions';
import Welcome from './pages/Welcome';
import Moderation from './pages/Moderation';
import Tickets from './pages/Tickets';
import News from './pages/News';
import Modules from './pages/Modules';
import Logs from './pages/Logs';
import Access from './pages/Access';

const NAV = [
    ['dashboard', 'Resumen', 'home'],
    ['compose', 'Enviar mensaje', 'send'],
    ['inbox', 'Bandeja', 'inbox'],
    ['history', 'Historial', 'list'],
    ['scheduler', 'Programación', 'clock'],
    ['confirmations', 'Confirmaciones', 'check'],
    ['servers', 'Servidores', 'server'],
    ['reactions', 'Roles por reacción', 'smile'],
    ['welcome', 'Bienvenida', 'wave'],
    ['moderation', 'Moderación', 'shield'],
    ['tickets', 'Tickets', 'ticket'],
    ['news', 'Noticias', 'list'],
    ['modules', 'Módulos', 'grid'],
    ['logs', 'Registros', 'terminal'],
    ['access', 'Acceso', 'settings'],
] as const;

const STAFF_PAGES: readonly string[] = ['dashboard', 'compose', 'inbox', 'history', 'moderation', 'tickets', 'logs'];

function Login() {
    return (
        <div className="login">
            <div className="card stack">
                <div className="logo">KB</div>
                <div><h1>KB Bot</h1><p className="muted">Panel de gestión del bot</p></div>
                <a className="btn primary" style={{ justifyContent: 'center' }} href="/auth/login">Iniciar sesión con Discord</a>
                {import.meta.env.DEV && <a className="btn ghost" href="/auth/dev-login">Entrar en modo desarrollo</a>}
                <p className="hint">Solo pueden entrar las cuentas autorizadas en la configuración del bot.</p>
            </div>
        </div>
    );
}

export default function App() {
    const [me, setMe] = useState<Me | null | undefined>(undefined);
    const [unread, setUnread] = useState(0);
    const [waitingTickets, setWaitingTickets] = useState(0);
    const parts = useHash();
    const connected = useLiveConnected();

    useEffect(() => {
        get<Me>('/me').then(setMe).catch(() => setMe(null));
        const off = () => setMe(null);
        window.addEventListener('kb:unauthorized', off);
        return () => window.removeEventListener('kb:unauthorized', off);
    }, []);

    useEffect(() => {
        if (!me) return;
        startLive();
        get<{ unreadTotal: number }>('/inbox/conversations').then(r => setUnread(r.unreadTotal)).catch(() => undefined);
        refreshTickets();
        return stopLive;
    }, [me]);

    const refreshTickets = useCallback(() => {
        get<{ counts: { waiting: number } }>('/tickets?status=open').then(r => setWaitingTickets(r.counts.waiting)).catch(() => undefined);
    }, []);

    const refreshUnread = useCallback(() => {
        get<{ unreadTotal: number }>('/inbox/conversations').then(r => setUnread(r.unreadTotal)).catch(() => undefined);
    }, []);

    useLive(e => {
        if (e.type === 'inbox:read' || (e.type === 'message:new' && e.data?.direction === 'in')) refreshUnread();
        if (e.type === 'tickets:message' || e.type === 'tickets:changed') refreshTickets();
    });

    const logout = async () => {
        await fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'kb-panel' } }).catch(() => undefined);
        setMe(null);
    };

    if (me === undefined) return <div className="login"><Spinner /></div>;
    if (me === null) return <Login />;

    const owner = me.access === 'owner';
    const nav = owner ? NAV : NAV.filter(n => STAFF_PAGES.includes(n[0]));
    const page = nav.some(n => n[0] === parts[0]) ? parts[0] : 'dashboard';
    const flush = page === 'inbox' || (page === 'tickets' && !(owner && (parts[1] === 'panels' || parts[1] === 'settings')));
    return (
        <AccessContext.Provider value={me.access}>
        <ConfirmProvider>
            <div className="app">
                <aside className="sidebar">
                    <div className="brand"><div className="logo">KB</div><div><b>KB Bot</b><small>Panel de gestión</small></div></div>
                    <nav className="nav">
                        {nav.map(([id, label, icon]) => (
                            <a key={id} href={`#/${id}`} className={page === id ? 'active' : ''}>
                                <Icon name={icon} /> {label}
                                {id === 'inbox' && unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
                                {id === 'tickets' && waitingTickets > 0 && <span className="count" title="Tickets esperando respuesta">{waitingTickets > 99 ? '99+' : waitingTickets}</span>}
                            </a>
                        ))}
                    </nav>
                    <div className="spacer" />
                    <div className="conn"><span className={`dot ${connected ? 'on' : 'off'}`} />{connected ? 'Tiempo real activo' : 'Reconectando…'}</div>
                    <div className="userbox">
                        <Avatar src={me.avatar} name={me.username} />
                        <div className="grow"><div className="name">{me.username}</div></div>
                        <button className="btn ghost icon" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión"><Icon name="logout" /></button>
                    </div>
                </aside>
                <main className={`main ${flush ? 'flush' : ''}`}>
                    {page === 'dashboard' && <Dashboard />}
                    {page === 'compose' && <Compose />}
                    {page === 'inbox' && <Inbox userId={parts[1]} />}
                    {page === 'history' && <History />}
                    {page === 'scheduler' && <Scheduler />}
                    {page === 'confirmations' && <Confirmations />}
                    {page === 'servers' && <Servers />}
                    {page === 'reactions' && <Reactions />}
                    {page === 'welcome' && <Welcome />}
                    {page === 'moderation' && <Moderation />}
                    {page === 'tickets' && <Tickets sub={parts[1]} />}
                    {page === 'news' && <News />}
                    {page === 'modules' && <Modules />}
                    {page === 'logs' && <Logs />}
                    {page === 'access' && <Access />}
                </main>
            </div>
            <Toasts />
        </ConfirmProvider>
        </AccessContext.Provider>
    );
}
