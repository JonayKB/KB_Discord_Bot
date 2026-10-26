import { EventEmitter } from 'node:events';

export interface BusEvent {
    type: string;
    data?: unknown;
    ts: number;
}

/**
 * Bus interno de eventos. Todo lo que se publica aquí se reenvía por WebSocket
 * al panel, así la interfaz se actualiza en tiempo real sin recargar.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function publish(type: string, data?: unknown): void {
    const event: BusEvent = { type, data, ts: Date.now() };
    bus.emit('event', event);
}
