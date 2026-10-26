import { Cron } from 'croner';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { BotError, HttpError, parseJson } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { ConfirmationService } from '../confirmations/service';
import { parseTarget } from '../messages/parse';
import type { EmbedPayload, MessagesService, Target } from '../messages/service';

const logger = new Logger('Scheduler');

export type ScheduleType = 'cron' | 'interval' | 'once';
export type ActionType = 'send_template' | 'send_campaign';

export interface JobAction {
    templateId?: number;
    target?: Target;
    campaignId?: number;
}

interface JobRow {
    id: number;
    name: string;
    enabled: number;
    schedule_type: ScheduleType;
    schedule: string;
    start_at: number | null;
    timezone: string | null;
    action_type: ActionType;
    action_json: string;
    last_run_at: number | null;
    last_status: string | null;
    last_result: string | null;
    run_count: number;
    created_at: number;
    updated_at: number;
}

export interface Job {
    id: number;
    name: string;
    enabled: boolean;
    scheduleType: ScheduleType;
    schedule: string;
    startAt: number | null;
    timezone: string | null;
    actionType: ActionType;
    action: JobAction;
    lastRunAt: number | null;
    lastStatus: string | null;
    lastResult: string | null;
    runCount: number;
    nextRunAt: number | null;
    running: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface JobInput {
    name: string;
    enabled: boolean;
    scheduleType: ScheduleType;
    schedule: string;
    startAt: number | null;
    timezone: string | null;
    actionType: ActionType;
    action: JobAction;
}

type Handle = { kind: 'cron'; cron: Cron } | { kind: 'timer'; timer: NodeJS.Timeout; next: number };

const MAX_TIMEOUT = 2_147_000_000; // ~24,8 días: límite de setTimeout
const MIN_INTERVAL_S = 60;

export function nextIntervalRun(startAt: number, intervalMs: number, from = Date.now()): number {
    if (from < startAt) return startAt;
    return startAt + (Math.floor((from - startAt) / intervalMs) + 1) * intervalMs;
}

function validTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export class SchedulerService {
    private readonly handles = new Map<number, Handle>();
    private readonly running = new Set<number>();
    private started = false;

    constructor(
        private readonly db: DB,
        private readonly messages: MessagesService,
        private readonly confirmations: ConfirmationService
    ) {}

    // ─────────────────────────── Ciclo de vida ───────────────────────────

    start(): void {
        this.started = true;
        for (const job of this.listJobs()) {
            if (job.enabled) this.arm(job, true);
        }
        logger.info(`⏰ Programador iniciado con ${this.handles.size} tareas activas`);
    }

    stop(): void {
        this.started = false;
        for (const id of [...this.handles.keys()]) this.disarm(id);
    }

    // ───────────────────────────── Consultas ─────────────────────────────

    private toJob(r: JobRow): Job {
        const h = this.handles.get(r.id);
        let nextRunAt: number | null = null;
        if (h?.kind === 'cron') nextRunAt = h.cron.nextRun()?.getTime() ?? null;
        else if (h?.kind === 'timer') nextRunAt = h.next;
        return {
            id: r.id,
            name: r.name,
            enabled: !!r.enabled,
            scheduleType: r.schedule_type,
            schedule: r.schedule,
            startAt: r.start_at,
            timezone: r.timezone,
            actionType: r.action_type,
            action: parseJson<JobAction>(r.action_json, {}),
            lastRunAt: r.last_run_at,
            lastStatus: r.last_status,
            lastResult: r.last_result,
            runCount: r.run_count,
            nextRunAt,
            running: this.running.has(r.id),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        };
    }

    listJobs(): Job[] {
        return (this.db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[]).map(r => this.toJob(r));
    }

    getJob(id: number): Job | null {
        const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
        return row ? this.toJob(row) : null;
    }

    private requireJob(id: number): Job {
        const job = this.getJob(id);
        if (!job) throw new HttpError(404, 'Programación no encontrada');
        return job;
    }

    // ─────────────────────────────── CRUD ───────────────────────────────

    create(input: JobInput): Job {
        this.validate(input);
        const now = Date.now();
        const res = this.db.prepare(`
            INSERT INTO jobs (name, enabled, schedule_type, schedule, start_at, timezone, action_type, action_json, created_at, updated_at)
            VALUES (@name, @enabled, @scheduleType, @schedule, @startAt, @timezone, @actionType, @action, @now, @now)
        `).run({ ...this.params(input), now });
        return this.afterChange(Number(res.lastInsertRowid));
    }

    update(id: number, input: JobInput): Job {
        this.requireJob(id);
        this.validate(input);
        this.db.prepare(`
            UPDATE jobs SET name=@name, enabled=@enabled, schedule_type=@scheduleType, schedule=@schedule, start_at=@startAt,
                timezone=@timezone, action_type=@actionType, action_json=@action, updated_at=@now WHERE id=@id
        `).run({ ...this.params(input), now: Date.now(), id });
        return this.afterChange(id);
    }

    setEnabled(id: number, enabled: boolean): Job {
        const job = this.requireJob(id);
        if (enabled) this.validate({ ...job, enabled });
        this.db.prepare('UPDATE jobs SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
        return this.afterChange(id);
    }

    remove(id: number): void {
        this.requireJob(id);
        this.disarm(id);
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        publish('job:deleted', { id });
    }

    private params(i: JobInput) {
        return {
            name: i.name,
            enabled: i.enabled ? 1 : 0,
            scheduleType: i.scheduleType,
            schedule: i.schedule,
            startAt: i.startAt,
            timezone: i.timezone,
            actionType: i.actionType,
            action: JSON.stringify(i.action),
        };
    }

    /** Re-programa la tarea en caliente tras crearla o editarla: no hace falta reiniciar el bot. */
    private afterChange(id: number): Job {
        this.disarm(id);
        const job = this.requireJob(id);
        if (this.started && job.enabled) this.arm(job, false);
        const fresh = this.requireJob(id);
        publish('job:updated', fresh);
        return fresh;
    }

    // ───────────────────────────── Validación ─────────────────────────────

    validate(i: Pick<JobInput, 'scheduleType' | 'schedule' | 'startAt' | 'timezone' | 'actionType' | 'action' | 'enabled'>): void {
        if (i.timezone && !validTimezone(i.timezone)) throw new HttpError(400, `Zona horaria no válida: ${i.timezone}`);
        this.nextRuns(i, 1, !i.enabled);

        if (i.actionType === 'send_template') {
            const exists = this.db.prepare('SELECT 1 FROM templates WHERE id = ?').get(i.action.templateId ?? -1);
            if (!exists) throw new HttpError(400, 'Elige una plantilla de mensaje válida.');
            if (!i.action.target) throw new HttpError(400, 'Elige a quién enviar el mensaje.');
            parseTarget(i.action.target);
        } else {
            const exists = this.db.prepare('SELECT 1 FROM campaigns WHERE id = ?').get(i.action.campaignId ?? -1);
            if (!exists) throw new HttpError(400, 'Elige una campaña de confirmación válida.');
        }
    }

    /** Próximas ejecuciones (también sirve para validar la programación). */
    nextRuns(spec: Pick<JobInput, 'scheduleType' | 'schedule' | 'startAt' | 'timezone' | 'enabled'>, count = 5, validateOnly = false): number[] {
        const tz = spec.timezone || env.timezone;
        switch (spec.scheduleType) {
            case 'cron': {
                try {
                    const cron = new Cron(spec.schedule, { timezone: tz, paused: true });
                    const runs = cron.nextRuns(count).map(d => d.getTime());
                    cron.stop();
                    if (!runs.length && !validateOnly) throw new Error('La expresión no genera ninguna ejecución futura.');
                    return runs;
                } catch (err) {
                    throw new HttpError(400, `Expresión cron no válida: ${(err as Error).message}`);
                }
            }
            case 'interval': {
                const seconds = Number(spec.schedule);
                if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_S) {
                    throw new HttpError(400, `El intervalo mínimo es ${MIN_INTERVAL_S} segundos.`);
                }
                const ms = seconds * 1000;
                const anchor = spec.startAt ?? Date.now();
                const out: number[] = [];
                let from = Date.now();
                for (let i = 0; i < count; i++) {
                    const next = nextIntervalRun(anchor, ms, from);
                    out.push(next);
                    from = next;
                }
                return out;
            }
            case 'once': {
                const t = Date.parse(spec.schedule);
                if (Number.isNaN(t)) throw new HttpError(400, 'Fecha no válida.');
                if (t <= Date.now() && spec.enabled && !validateOnly) throw new HttpError(400, 'Esa fecha ya ha pasado.');
                return t > Date.now() ? [t] : [];
            }
            default:
                throw new HttpError(400, 'Tipo de programación no válido.');
        }
    }

    // ───────────────────────────── Programación ─────────────────────────────

    private arm(job: Job, atStartup: boolean): void {
        this.disarm(job.id);
        try {
            switch (job.scheduleType) {
                case 'cron': {
                    const cron = new Cron(job.schedule, { timezone: job.timezone || env.timezone, protect: true }, () => {
                        void this.run(job.id, 'schedule').catch(() => undefined);
                    });
                    this.handles.set(job.id, { kind: 'cron', cron });
                    break;
                }
                case 'interval': {
                    const ms = Number(job.schedule) * 1000;
                    const anchor = job.startAt ?? job.createdAt;
                    this.armTimer(job.id, nextIntervalRun(anchor, ms), () => {
                        void this.run(job.id, 'schedule').catch(() => undefined).finally(() => {
                            const fresh = this.getJob(job.id);
                            if (this.started && fresh?.enabled) this.arm(fresh, false);
                            if (fresh) publish('job:updated', fresh);
                        });
                    });
                    break;
                }
                case 'once': {
                    const at = Date.parse(job.schedule);
                    const overdue = Date.now() - at;
                    if (overdue > 0) {
                        // Solo recuperamos una tarea "una vez" perdida si el bot estuvo caído menos de 10 minutos.
                        if (atStartup && !job.lastRunAt && overdue < 10 * 60 * 1000) {
                            this.armTimer(job.id, Date.now() + 5000, () => void this.run(job.id, 'schedule').catch(() => undefined));
                        } else if (atStartup && !job.lastRunAt) {
                            this.db.prepare("UPDATE jobs SET enabled = 0, last_status = 'missed', last_result = 'El bot estaba apagado a la hora programada.' WHERE id = ?").run(job.id);
                        }
                        break;
                    }
                    this.armTimer(job.id, at, () => void this.run(job.id, 'schedule').catch(() => undefined));
                    break;
                }
            }
        } catch (err) {
            logger.error(`No se pudo programar la tarea "${job.name}"`, err);
        }
    }

    private armTimer(id: number, target: number, onFire: () => void): void {
        const handle: { kind: 'timer'; timer: NodeJS.Timeout; next: number } = { kind: 'timer', timer: undefined as unknown as NodeJS.Timeout, next: target };
        const tick = () => {
            const delay = target - Date.now();
            if (delay > MAX_TIMEOUT) handle.timer = setTimeout(tick, MAX_TIMEOUT);
            else if (delay > 50) handle.timer = setTimeout(tick, delay);
            else onFire();
        };
        this.handles.set(id, handle);
        tick();
    }

    private disarm(id: number): void {
        const h = this.handles.get(id);
        if (!h) return;
        if (h.kind === 'cron') h.cron.stop();
        else clearTimeout(h.timer);
        this.handles.delete(id);
    }

    // ───────────────────────────── Ejecución ─────────────────────────────

    async run(id: number, trigger: 'schedule' | 'manual'): Promise<void> {
        const job = this.requireJob(id);
        if (this.running.has(id)) throw new HttpError(409, 'Esta tarea ya se está ejecutando.');
        this.running.add(id);
        publish('job:updated', this.requireJob(id));
        logger.info(`▶️ Ejecutando "${job.name}" (${trigger === 'manual' ? 'manual' : 'programada'})`);

        let status: 'ok' | 'error' = 'ok';
        let result = '';
        try {
            result = await this.execute(job);
        } catch (err) {
            status = 'error';
            result = err instanceof Error ? err.message : String(err);
            if (!(err instanceof BotError || err instanceof HttpError)) logger.error(`Error en la tarea "${job.name}"`, err);
        } finally {
            this.running.delete(id);
        }

        const done = job.scheduleType === 'once' && trigger === 'schedule';
        this.db.prepare(`
            UPDATE jobs SET last_run_at = ?, last_status = ?, last_result = ?, run_count = run_count + 1,
                enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE id = ?
        `).run(Date.now(), status, result.slice(0, 500), done ? 1 : 0, id);
        if (done) this.disarm(id);

        const fresh = this.getJob(id);
        if (fresh) publish('job:updated', fresh);
        logger.info(`${status === 'ok' ? '✅' : '❌'} "${job.name}": ${result}`);
    }

    private async execute(job: Job): Promise<string> {
        const meta = { source: 'schedule' as const, sourceRef: String(job.id) };

        if (job.actionType === 'send_campaign') {
            if (!this.confirmations.active) throw new BotError('El módulo de confirmaciones está desactivado.');
            const r = await this.confirmations.sendForm(job.action.campaignId ?? -1);
            return r.total === 0 ? 'Nadie pendiente: no se envió nada.' : `${r.sent} enviados, ${r.failed} fallidos (de ${r.total}).`;
        }

        const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(job.action.templateId ?? -1) as
            | { content: string; embed_json: string | null; file_ids: string } | undefined;
        if (!row) throw new BotError('La plantilla de esta tarea ya no existe.');
        const payload = {
            content: row.content,
            embed: parseJson<EmbedPayload | null>(row.embed_json, null),
            fileIds: parseJson<string[]>(row.file_ids, []),
        };
        const target = parseTarget(job.action.target);

        if (target.type === 'channel') {
            const rec = await this.messages.sendToChannel(target.id, payload, meta);
            if (rec.status === 'failed') throw new BotError(rec.error ?? 'No se pudo enviar');
            return 'Enviado al canal.';
        }
        const ids = this.messages.resolveUserIds(target);
        if (!ids.length) return 'Sin destinatarios.';
        const r = await this.messages.sendBulk(ids, payload, meta);
        return `${r.sent} enviados, ${r.failed} fallidos (de ${r.total}).`;
    }
}
