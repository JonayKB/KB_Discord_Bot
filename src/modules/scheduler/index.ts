import { Router } from 'express';
import { HttpError, asyncRoute, bool, int, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import type { JobAction, JobInput, SchedulerService } from './service';

/* eslint-disable @typescript-eslint/no-explicit-any */

function parseJob(body: any): JobInput {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Datos no válidos');
    const scheduleType = body.scheduleType;
    if (scheduleType !== 'cron' && scheduleType !== 'interval' && scheduleType !== 'once') {
        throw new HttpError(400, 'Tipo de programación no válido');
    }
    const actionType = body.actionType;
    if (actionType !== 'send_template' && actionType !== 'send_campaign') {
        throw new HttpError(400, 'Tipo de acción no válido');
    }
    const a = body.action ?? {};
    const action: JobAction = actionType === 'send_template'
        ? { templateId: int(a.templateId, 'action.templateId', { min: 1 }), target: a.target }
        : { campaignId: int(a.campaignId, 'action.campaignId', { min: 1 }) };

    let startAt: number | null = null;
    if (scheduleType === 'interval' && body.startAt) {
        startAt = typeof body.startAt === 'number' ? body.startAt : Date.parse(String(body.startAt));
        if (Number.isNaN(startAt)) throw new HttpError(400, 'La fecha de inicio no es válida');
    }
    return {
        name: str(body.name, 'name', { required: true, max: 80 }),
        enabled: body.enabled === undefined ? true : bool(body.enabled),
        scheduleType,
        schedule: str(String(body.schedule ?? ''), 'schedule', { required: true, max: 120 }),
        startAt,
        timezone: str(body.timezone, 'timezone', { max: 64 }) || null,
        actionType,
        action,
    };
}

export function createSchedulerModule(service: SchedulerService): BotModule {
    const router = Router();

    router.get('/jobs', (_req, res) => res.json(service.listJobs()));

    router.post('/jobs', asyncRoute((req, res) => {
        res.status(201).json(service.create(parseJob(req.body)));
    }));

    router.put('/jobs/:id', asyncRoute((req, res) => {
        res.json(service.update(int(req.params.id, 'id', { min: 1 }), parseJob(req.body)));
    }));

    router.post('/jobs/:id/enabled', asyncRoute((req, res) => {
        res.json(service.setEnabled(int(req.params.id, 'id', { min: 1 }), bool(req.body?.enabled)));
    }));

    router.post('/jobs/:id/run', asyncRoute((req, res) => {
        const id = int(req.params.id, 'id', { min: 1 });
        if (!service.getJob(id)) throw new HttpError(404, 'Programación no encontrada');
        if (service.getJob(id)!.running) throw new HttpError(409, 'Esta tarea ya se está ejecutando.');
        void service.run(id, 'manual').catch(() => undefined);
        res.status(202).json({ ok: true });
    }));

    router.delete('/jobs/:id', asyncRoute((req, res) => {
        service.remove(int(req.params.id, 'id', { min: 1 }));
        res.json({ ok: true });
    }));

    /** Vista previa de las próximas ejecuciones sin guardar nada (para el editor del panel). */
    router.post('/preview', asyncRoute((req, res) => {
        const b = req.body ?? {};
        const scheduleType = b.scheduleType;
        if (scheduleType !== 'cron' && scheduleType !== 'interval' && scheduleType !== 'once') {
            throw new HttpError(400, 'Tipo de programación no válido');
        }
        let startAt: number | null = null;
        if (scheduleType === 'interval' && b.startAt) {
            startAt = typeof b.startAt === 'number' ? b.startAt : Date.parse(String(b.startAt));
            if (Number.isNaN(startAt)) throw new HttpError(400, 'La fecha de inicio no es válida');
        }
        const runs = service.nextRuns({
            scheduleType,
            schedule: String(b.schedule ?? ''),
            startAt,
            timezone: str(b.timezone, 'timezone', { max: 64 }) || null,
            enabled: true,
        }, 5);
        res.json({ runs });
    }));

    return {
        id: 'scheduler',
        name: 'Programación',
        description: 'Tareas programadas editables en caliente: envía plantillas o formularios de confirmación cada día, cada N horas/días, en días concretos o una sola vez. Pausa, cambia o ejecuta al momento sin reiniciar.',
        router,
        start() {
            service.start();
        },
        stop() {
            service.stop();
        },
    };
}
