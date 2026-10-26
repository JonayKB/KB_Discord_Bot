import { useEffect, useMemo, useRef, useState } from 'react';
import { get, type LogEntry } from '../api';
import { useLive } from '../live';
import { PageHead, errMsg, toast } from '../ui';

const ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export default function Logs() {
    const [lines, setLines] = useState<LogEntry[]>([]);
    const [level, setLevel] = useState<keyof typeof ORDER>('info');
    const [filter, setFilter] = useState('');
    const [follow, setFollow] = useState(true);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => { get<LogEntry[]>(`/logs?level=debug&limit=1000`).then(setLines).catch(e => toast.error(errMsg(e))); }, []);
    useLive(e => { if (e.type === 'log') setLines(l => [...l.slice(-999), e.data as LogEntry]); });

    const shown = useMemo(() => lines.filter(l => ORDER[l.level] >= ORDER[level] && (!filter || `${l.scope} ${l.message}`.toLowerCase().includes(filter.toLowerCase()))), [lines, level, filter]);

    useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown, follow]);

    return (
        <div className="page">
            <PageHead title="Registros" subtitle="Lo que hace el bot en directo (últimas 1000 líneas).">
                <input type="search" placeholder="Filtrar…" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 180 }} />
                <select style={{ width: 'auto' }} value={level} onChange={e => setLevel(e.target.value as keyof typeof ORDER)}>
                    <option value="debug">Todo</option><option value="info">Info y superior</option><option value="warn">Avisos y errores</option><option value="error">Solo errores</option>
                </select>
                <label className="check"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Seguir</label>
                <button className="btn" onClick={() => setLines([])}>Limpiar vista</button>
            </PageHead>
            <div className="logbox" ref={box}>
                {shown.length === 0 && <span className="muted">Sin líneas.</span>}
                {shown.map((l, i) => (
                    <div key={i} className={`logline ${l.level}`}>
                        <span className="ts">{new Date(l.ts).toLocaleTimeString('es-ES')}</span> {l.scope && <span className="scope">[{l.scope}]</span>} {l.message.replace(/\x1b\[[0-9;]*m/g, '')}
                    </div>
                ))}
            </div>
        </div>
    );
}
