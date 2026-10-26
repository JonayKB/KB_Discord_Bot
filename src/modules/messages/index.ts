import crypto from 'node:crypto';
import { Router } from 'express';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { HttpError, asyncRoute, int, parseJson, str, strArray } from '../../core/http';
import { getFiles } from '../../core/files';
import type { BotModule } from '../../core/module';
import { parseEmbed, parsePayload, parseTarget } from './parse';
import { MessagesService, type EmbedPayload, type MessageSource } from './service';

export { MessagesService } from './service';

interface TemplateRow {
    id: number;
    name: string;
    content: string;
    embed_json: string | null;
    file_ids: string;
    created_at: number;
    updated_at: number;
}

export function toTemplate(db: DB, r: TemplateRow) {
    const fileIds = parseJson<string[]>(r.file_ids, []);
    return {
        id: r.id,
        name: r.name,
        content: r.content,
        embed: parseJson<EmbedPayload | null>(r.embed_json, null),
        fileIds,
        files: getFiles(db, fileIds).map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.id}` })),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

export function createMessagesModule(service: MessagesService, db: DB): BotModule {
    const router = Router();

    // ── Enviar ──
    router.post('/send', asyncRoute(async (req, res) => {
        const target = parseTarget(req.body?.target);
        const payload = parsePayload(req.body?.payload);
        const meta = { source: 'manual' as MessageSource };

        if (target.type === 'channel') {
            res.json(await service.sendToChannel(target.id, payload, meta));
            return;
        }
        const userIds = service.resolveUserIds(target);
        if (!userIds.length) throw new HttpError(400, 'No hay ningún destinatario.');

        if (userIds.length === 1) {
            res.json(await service.sendToUser(userIds[0], payload, meta));
            return;
        }
        const batchId = crypto.randomUUID();
        void service.sendBulk(userIds, payload, { ...meta, sourceRef: 'bulk' }, { batchId }).catch(() => undefined);
        res.status(202).json({ batchId, total: userIds.length });
    }));

    router.get('/audience', asyncRoute((req, res) => {
        const type = String(req.query.type ?? '');
        const id = String(req.query.id ?? '');
        if (type === 'all') return res.json({ count: service.resolveUserIds({ type: 'all' }).length });
        if (type === 'role') return res.json({ count: service.resolveUserIds({ type: 'role', id }).length });
        throw new HttpError(400, 'Tipo no válido');
    }));

    router.get('/batches/:id', (req, res) => {
        const b = service.batch(String(req.params.id));
        if (!b) return res.status(404).json({ error: 'Lote no encontrado' });
        res.json(b);
    });

    // ── Historial ──
    router.get('/history', asyncRoute((req, res) => {
        const q = req.query;
        const direction = q.direction === 'in' || q.direction === 'out' ? q.direction : undefined;
        const kind = q.kind === 'dm' || q.kind === 'channel' ? q.kind : undefined;
        res.json(service.list({
            direction,
            kind,
            source: typeof q.source === 'string' && q.source ? q.source : undefined,
            status: typeof q.status === 'string' && q.status ? q.status : undefined,
            q: typeof q.q === 'string' && q.q ? q.q : undefined,
            userId: typeof q.userId === 'string' && q.userId ? q.userId : undefined,
            limit: q.limit ? int(q.limit, 'limit', { min: 1, max: 200 }) : 50,
            before: q.before ? int(q.before, 'before', { min: 1 }) : undefined,
        }));
    }));

    router.delete('/history/:id', asyncRoute((req, res) => {
        const ok = service.deleteFromLog(int(req.params.id, 'id', { min: 1 }));
        if (!ok) throw new HttpError(404, 'Mensaje no encontrado');
        res.json({ ok: true });
    }));

    // ── Plantillas ──
    const readTemplate = (body: Record<string, unknown>) => ({
        name: str(body.name, 'name', { required: true, max: 80 }),
        content: str(body.content, 'content', { max: 2000 }),
        embed: parseEmbed(body.embed),
        fileIds: strArray(body.fileIds, 'fileIds', 10),
    });

    router.get('/templates', (_req, res) => {
        const rows = db.prepare('SELECT * FROM templates ORDER BY name COLLATE NOCASE').all() as TemplateRow[];
        res.json(rows.map(r => toTemplate(db, r)));
    });

    router.post('/templates', asyncRoute((req, res) => {
        const t = readTemplate(req.body ?? {});
        const now = Date.now();
        const result = db.prepare(
            'INSERT INTO templates (name, content, embed_json, file_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(t.name, t.content, t.embed ? JSON.stringify(t.embed) : null, JSON.stringify(t.fileIds), now, now);
        const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(result.lastInsertRowid) as TemplateRow;
        res.status(201).json(toTemplate(db, row));
    }));

    router.put('/templates/:id', asyncRoute((req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        const t = readTemplate(req.body ?? {});
        const result = db.prepare(
            'UPDATE templates SET name = ?, content = ?, embed_json = ?, file_ids = ?, updated_at = ? WHERE id = ?'
        ).run(t.name, t.content, t.embed ? JSON.stringify(t.embed) : null, JSON.stringify(t.fileIds), Date.now(), id);
        if (!result.changes) throw new HttpError(404, 'Plantilla no encontrada');
        res.json(toTemplate(db, db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow));
    }));

    router.delete('/templates/:id', asyncRoute((req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        const used = db.prepare("SELECT name FROM jobs WHERE action_type = 'send_template' AND json_extract(action_json, '$.templateId') = ?").get(id) as { name: string } | undefined;
        if (used) throw new HttpError(409, `La plantilla la usa la programación "${used.name}". Elimínala o cámbiala primero.`);
        const result = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
        if (!result.changes) throw new HttpError(404, 'Plantilla no encontrada');
        res.json({ ok: true });
    }));

    return {
        id: 'messages',
        name: 'Mensajes',
        description: 'Enviar mensajes (texto, embeds e imágenes) a usuarios, roles o canales, y guardar historial. Al desactivarlo se pausan TODOS los envíos del bot.',
        router,
        start() {
            service.active = true;
            publish('messages:active', true);
        },
        stop() {
            service.active = false;
            publish('messages:active', false);
        },
    };
}
