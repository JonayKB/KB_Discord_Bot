import { useEffect, useRef, useState } from 'react';

export interface LiveEvent { type: string; data?: any; ts: number }

type Handler = (e: LiveEvent) => void;

const handlers = new Set<Handler>();
const statusListeners = new Set<(connected: boolean) => void>();
let socket: WebSocket | null = null;
let connected = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

function setConnected(v: boolean) {
    connected = v;
    statusListeners.forEach(fn => fn(v));
}

export function startLive(): void {
    stopped = false;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => setConnected(true);
    socket.onmessage = ev => {
        try {
            const e = JSON.parse(ev.data) as LiveEvent;
            handlers.forEach(h => h(e));
        } catch { /* ignorar */ }
    };
    socket.onclose = () => {
        setConnected(false);
        socket = null;
        if (!stopped) retry = setTimeout(startLive, 2000);
    };
    socket.onerror = () => socket?.close();
}

export function stopLive(): void {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
}

/** Suscribe un componente a los eventos en tiempo real del bot. */
export function useLive(handler: Handler): void {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        const h: Handler = e => ref.current(e);
        handlers.add(h);
        return () => { handlers.delete(h); };
    }, []);
}

export function useLiveConnected(): boolean {
    const [v, setV] = useState(connected);
    useEffect(() => {
        statusListeners.add(setV);
        setV(connected);
        return () => { statusListeners.delete(setV); };
    }, []);
    return v;
}
