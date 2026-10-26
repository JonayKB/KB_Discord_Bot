import { HttpError, bool, str, strArray } from '../../core/http';
import type { EmbedPayload, OutgoingPayload, Target } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function parseEmbed(raw: any): EmbedPayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const embed: EmbedPayload = {
        title: str(raw.title, 'embed.title', { max: 256 }) || undefined,
        description: str(raw.description, 'embed.description', { max: 4096 }) || undefined,
        color: str(raw.color, 'embed.color', { max: 7 }) || undefined,
        footer: str(raw.footer, 'embed.footer', { max: 2048 }) || undefined,
        author: str(raw.author, 'embed.author', { max: 256 }) || undefined,
        thumbnail: str(raw.thumbnail, 'embed.thumbnail', { max: 500 }) || undefined,
        timestamp: bool(raw.timestamp) || undefined,
    };
    return embed.title || embed.description ? embed : null;
}

export function parsePayload(raw: any): OutgoingPayload {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Falta el contenido del mensaje');
    return {
        content: str(raw.content, 'content', { max: 2000 }),
        embed: parseEmbed(raw.embed),
        fileIds: strArray(raw.fileIds, 'fileIds', 10),
    };
}

export function parseTarget(raw: any): Target {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Falta el destinatario');
    switch (raw.type) {
        case 'user':
            return { type: 'user', id: str(raw.id, 'target.id', { required: true, max: 32 }) };
        case 'users': {
            const ids = strArray(raw.ids, 'target.ids', 1000);
            if (!ids.length) throw new HttpError(400, 'Selecciona al menos un usuario');
            return { type: 'users', ids };
        }
        case 'role':
            return { type: 'role', id: str(raw.id, 'target.id', { required: true, max: 32 }) };
        case 'channel':
            return { type: 'channel', id: str(raw.id, 'target.id', { required: true, max: 32 }) };
        case 'all':
            return { type: 'all' };
        default:
            throw new HttpError(400, 'Tipo de destinatario no válido');
    }
}
