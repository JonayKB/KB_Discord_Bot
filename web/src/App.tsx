import { useCallback, useEffect, useState } from 'react';
import { useHash } from './nav';
import { get } from './api';
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
import Modules from './pages/Modules';
import Logs from './pages/Logs';

interface Me { userId: string; username: string; avatar: string | null }

const NAV = [
    ['dashboard', 'Resumen', 'home'],
    ['compose', 'Enviar mensaje', 'send'],
    ['inbox', 'Bandeja', 'inbox'],
    ['history', 'Historial', 'list'],
    ['scheduler', 'Programación', 'clock'],
    ['confirmations', 'Confirmaciones', 'check'],
    ['servers', 'Servidores', 'server'],
    ['reactions', 'Roles por reacción', 'smile'],
    ['modules', 'Módulos', 'grid'],
    ['logs', 'Registros', 'terminal'],
] as const;

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
    const parts = useHash();
    const page = parts[0] ?? 'dashboard';
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
        return stopLive;
    }, [me]);

    const refreshUnread = useCallback(() => {
        get<{ unreadTotal: number }>('/inbox/conversations').then(r => setUnread(r.unreadTotal)).catch(() => undefined);
    }, []);

    useLive(e => {
        if (e.type === 'inbox:read' || (e.type === 'message:new' && e.data?.direction === 'in')) refreshUnread();
    });

    const logout = async () => {
        await fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'kb-panel' } }).catch(() => undefined);
        setMe(null);
    };

    if (me === undefined) return <div className="login"><Spinner /></div>;
    if (me === null) return <Login />;

    const flush = page === 'inbox';
    return (
        <ConfirmProvider>
            <div className="app">
                <aside className="sidebar">
                    <div className="brand"><div className="logo">KB</div><div><b>KB Bot</b><small>Panel de gestión</small></div></div>
                    <nav className="nav">
                        {NAV.map(([id, label, icon]) => (
                            <a key={id} href={`#/${id}`} className={page === id ? 'active' : ''}>
                                <Icon name={icon} /> {label}
                                {id === 'inbox' && unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
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
                    {page === 'modules' && <Modules />}
                    {page === 'logs' && <Logs />}
                    {!NAV.some(n => n[0] === page) && <Dashboard />}
                </main>
            </div>
            <Toasts />
        </ConfirmProvider>
    );
}
