import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str, strArray } from '../../core/http';
import type { BotModule } from '../../core/module';
import { BUTTON_STYLES, pad, type ButtonStyleName, type PanelInput, type TicketsConfig, type TicketsService } from './service';

export { TicketsService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

function parsePanel(body: any): PanelInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos no válidos');
    if (!Array.isArray(body.types)) throw new HttpError(400, '"types" debe ser una lista');
    const color = str(body.color, 'color', { max: 7 }) || '#5865F2';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'El color debe ser HEX (#RRGGBB)');
    return {
        name: str(body.name, 'name', { required: true, max: 80 }).trim(),
        title: str(body.title, 'title', { max: 256 }).trim() || '🎫 Tickets',
        description: str(body.description, 'description', { max: 3000 }),
        color,
        types: body.types.slice(0, 26).map((t: any, i: number) => {
            const f = (k: string) => `types[${i}].${k}`;
            const style = (t?.style ?? 'primary') as ButtonStyleName;
            if (!BUTTON_STYLES.includes(style)) throw new HttpError(400, `Color de botón no válido en "${t?.label}"`);
            if (!Array.isArray(t?.questions ?? [])) throw new HttpError(400, `${f('questions')} debe ser una lista`);
            return {
                id: t?.id ? int(t.id, f('id'), { min: 1 }) : undefined,
                label: str(t?.label, f('label'), { required: true, max: 80 }).trim(),
                emoji: str(t?.emoji, f('emoji'), { max: 64 }).trim(),
                style,
                categoryId: str(t?.categoryId, f('categoryId'), { max: 32 }) || null,
                supportRoleIds: strArray(t?.supportRoleIds, f('supportRoleIds'), 20),
                nameTemplate: str(t?.nameTemplate, f('nameTemplate'), { max: 80 }).trim() || 'ticket-{number}',
                welcome: str(t?.welcome, f('welcome'), { max: 3000 }),
                questions: (t?.questions ?? []).map((q: any, n: number) => ({
                    label: str(q?.label, `${f('questions')}[${n}].label`, { required: true, max: 45 }).trim(),
                    placeholder: str(q?.placeholder, `${f('questions')}[${n}].placeholder`, { max: 100 }),
                    long: bool(q?.long),
                    required: q?.required === undefined ? true : bool(q.required),
                })),
                maxOpen: t?.maxOpen === undefined ? 1 : int(t.maxOpen, f('maxOpen'), { min: 0, max: 10 }),
            };
        }),
    };
}

function parseConfig(body: any): TicketsConfig {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Configuración no válida');
    return {
        logChannelId: str(body.logChannelId, 'logChannelId', { max: 32 }) || null,
        deleteOnClose: body.deleteOnClose === undefined ? true : bool(body.deleteOnClose),
        closeDelaySec: body.closeDelaySec === undefined ? 10 : int(body.closeDelaySec, 'closeDelaySec', { min: 0, max: 300 }),
        dmOnClose: body.dmOnClose === undefined ? true : bool(body.dmOnClose),
        attachTranscript: body.attachTranscript === undefined ? true : bool(body.attachTranscript),
    };
}

export function createTicketsModule(service: TicketsService): BotModule {
    const router = Router();
    const id = (v: unknown) => int(v, 'id', { min: 1 });
    const me = (req: any) => ({ id: req.session!.userId as string, name: req.session!.username as string });

    // ── Configuración y paneles ──
    router.get('/config', (_req, res) => res.json(service.getConfig()));
    router.put('/config', (req, res) => res.json(service.setConfig(parseConfig(req.body))));

    router.get('/panels', (_req, res) => res.json(service.listPanels()));
    router.post('/panels', asyncRoute(async (req, res) => {
        res.status(201).json(await service.createPanel(parsePanel(req.body), str(req.body?.channelId, 'channelId', { max: 32 }) || null));
    }));
    router.put('/panels/:id', asyncRoute(async (req, res) => res.json(await service.updatePanel(id(req.params.id), parsePanel(req.body)))));
    router.post('/panels/:id/publish', asyncRoute(async (req, res) => {
        res.json(await service.publishPanel(id(req.params.id), str(req.body?.channelId, 'channelId', { required: true, max: 32 })));
    }));
    router.delete('/panels/:id', asyncRoute(async (req, res) => {
        await service.deletePanel(id(req.params.id), bool(req.query.message));
        res.json({ ok: true });
    }));

    // ── Tickets ──
    router.get('/', (req, res) => {
        const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : undefined;
        res.json({
            counts: service.counts(),
            tickets: service.list({ status, search: req.query.q ? String(req.query.q).slice(0, 80) : undefined, userId: req.query.userId ? String(req.query.userId) : undefined }),
        });
    });

    router.get('/:id', (req, res) => {
        const t = service.require(id(req.params.id));
        res.json({ ticket: t, messages: service.messagesOf(t.id) });
    });

    router.get('/:id/transcript', (req, res) => {
        const t = service.require(id(req.params.id));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="ticket-${pad(t.number)}.html"`);
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https:");
        res.send(service.transcriptHtml(t));
    });

    router.post('/:id/reply', asyncRoute(async (req, res) => {
        const content = str(req.body?.content, 'content', { max: 1900 });
        const fileIds = strArray(req.body?.fileIds, 'fileIds', 10);
        if (!content.trim() && !fileIds.length) throw new HttpError(400, 'Escribe algo o adjunta un archivo.');
        res.status(201).json(await service.reply(id(req.params.id), me(req), content, fileIds));
    }));

    router.post('/:id/claim', asyncRoute(async (req, res) => res.json(await service.claim(id(req.params.id), me(req)))));

    router.post('/:id/close', asyncRoute(async (req, res) => {
        res.json(await service.close(id(req.params.id), me(req), str(req.body?.reason, 'reason', { max: 500 }) || null));
    }));

    router.delete('/:id', (req, res) => {
        service.deleteTicket(id(req.params.id));
        res.json({ ok: true });
    });

    return {
        id: 'tickets',
        name: 'Tickets',
        description: 'Panel con botones para que los miembros abran tickets: cada uno crea un canal privado en una categoría con el staff. Desde aquí se responden, se cierran (con o sin motivo) y se guarda el historial con su transcripción.',
        router,
        start(ctx) {
            service.active = true;
            ctx.listen('interactionCreate', i => service.onInteraction(i));
            ctx.listen('messageCreate', m => service.onMessage(m));
            ctx.listen('channelDelete', c => service.onChannelDelete(c.id));
            ctx.onStop(() => { service.active = false; });
        },
    };
}
