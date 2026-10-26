import { publish } from './bus';
import { onLog, type LogEntry, type LogLevel } from '../utils/Logger';

const MAX = 1000;
const buffer: LogEntry[] = [];
let started = false;

/** Guarda las últimas líneas de log en memoria y las emite al panel en directo. */
export function startLogCapture(): void {
    if (started) return;
    started = true;
    onLog(entry => {
        buffer.push(entry);
        if (buffer.length > MAX) buffer.shift();
        publish('log', entry);
    });
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function getLogs(minLevel: LogLevel = 'info', limit = 300): LogEntry[] {
    return buffer.filter(e => ORDER[e.level] >= ORDER[minLevel]).slice(-limit);
}
