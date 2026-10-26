import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { UPLOADS_DIR } from './db';
import { Logger } from '../utils/Logger';

const logger = new Logger('Files');

export interface FileRow {
    id: string;
    name: string;
    mime: string;
    size: number;
    path: string | null;
    url: string | null;
    created_at: number;
}

export interface FileInfo {
    id: string;
    name: string;
    mime: string;
    size: number;
    isImage: boolean;
    url: string;
}

/** Solo estos tipos se muestran "inline" en el navegador (SVG/HTML excluidos a propósito: pueden ejecutar scripts). */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const isInlineImage = (mime: string): boolean => INLINE_IMAGES.has(mime.toLowerCase());

export function safeName(name: string): string {
    const base = path.basename(name).replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 120);
    return base || 'archivo';
}

export function registerFile(db: DB, f: { name: string; mime: string; size: number; path?: string; url?: string; id?: string }): FileRow {
    const row: FileRow = {
        id: f.id ?? crypto.randomUUID(),
        name: safeName(f.name),
        mime: f.mime || 'application/octet-stream',
        size: f.size,
        path: f.path ?? null,
        url: f.url ?? null,
        created_at: Date.now(),
    };
    db.prepare(
        'INSERT INTO files (id, name, mime, size, path, url, created_at) VALUES (@id, @name, @mime, @size, @path, @url, @created_at)'
    ).run(row);
    return row;
}

export function getFile(db: DB, id: string): FileRow | undefined {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

export function getFiles(db: DB, ids: string[]): FileRow[] {
    return ids.map(id => getFile(db, id)).filter((f): f is FileRow => !!f);
}

export function toFileInfo(f: FileRow): FileInfo {
    return {
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        isImage: isInlineImage(f.mime),
        url: f.path ? `/api/files/${f.id}` : (f.url ?? ''),
    };
}

/** Descarga un adjunto recibido por Discord a data/uploads para que no caduque el enlace del CDN. */
export async function downloadAttachment(
    db: DB,
    att: { url: string; name: string; contentType: string | null; size: number },
    maxBytes: number
): Promise<FileRow> {
    if (att.size <= maxBytes) {
        try {
            const res = await fetch(att.url);
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                const id = crypto.randomUUID();
                const filePath = path.join(UPLOADS_DIR, `${id}-${safeName(att.name)}`);
                fs.writeFileSync(filePath, buf);
                return registerFile(db, {
                    id,
                    name: att.name,
                    mime: att.contentType?.split(';')[0] ?? 'application/octet-stream',
                    size: buf.length,
                    path: filePath,
                });
            }
        } catch (err) {
            logger.warn(`No se pudo descargar el adjunto ${att.name}: ${String(err)}`);
        }
    }
    // Fallback: guardamos solo el enlace
    return registerFile(db, {
        name: att.name,
        mime: att.contentType?.split(';')[0] ?? 'application/octet-stream',
        size: att.size,
        url: att.url,
    });
}
