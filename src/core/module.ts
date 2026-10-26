import type { Client, ClientEvents } from 'discord.js';
import type { Router } from 'express';
import type { DB } from './db';
import { getSetting, setSetting } from './db';
import { publish } from './bus';
import { HttpError } from './http';
import { Logger } from '../utils/Logger';

export interface ModuleContext {
    client: Client;
    db: DB;
    logger: Logger;
    /** Registra un listener de Discord que se elimina solo al desactivar el módulo. */
    listen<K extends keyof ClientEvents>(event: K, handler: (...args: ClientEvents[K]) => unknown): void;
    /** setInterval que se cancela solo al desactivar el módulo. */
    every(ms: number, fn: () => unknown): void;
    /** Código de limpieza extra al desactivar el módulo. */
    onStop(fn: () => unknown): void;
}

export interface BotModule {
    id: string;
    name: string;
    description: string;
    /** Rutas HTTP del módulo; se montan en /api/<id> y devuelven 409 si el módulo está parado. */
    router?: Router;
    start(ctx: ModuleContext): void | Promise<void>;
    stop?(): void | Promise<void>;
}

interface Entry {
    mod: BotModule;
    running: boolean;
    error?: string;
    cleanup: Array<() => unknown>;
}

export interface ModuleInfo {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    running: boolean;
    error?: string;
}

/**
 * Registra, arranca y para módulos EN CALIENTE (sin reiniciar el bot).
 * El estado activado/desactivado se guarda en la base de datos.
 */
export class ModuleManager {
    private readonly entries = new Map<string, Entry>();
    private readonly logger = new Logger('Modules');

    constructor(private readonly client: Client, private readonly db: DB) {}

    register(mod: BotModule): void {
        if (this.entries.has(mod.id)) throw new Error(`Módulo duplicado: ${mod.id}`);
        this.entries.set(mod.id, { mod, running: false, cleanup: [] });
    }

    modules(): BotModule[] {
        return [...this.entries.values()].map(e => e.mod);
    }

    isEnabled(id: string): boolean {
        return getSetting(this.db, `module.${id}.enabled`, '1') === '1';
    }

    isRunning(id: string): boolean {
        return this.entries.get(id)?.running ?? false;
    }

    list(): ModuleInfo[] {
        return [...this.entries.values()].map(e => ({
            id: e.mod.id,
            name: e.mod.name,
            description: e.mod.description,
            enabled: this.isEnabled(e.mod.id),
            running: e.running,
            error: e.error,
        }));
    }

    async startEnabled(): Promise<void> {
        for (const id of this.entries.keys()) {
            if (this.isEnabled(id)) await this.start(id);
        }
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) throw new HttpError(404, `Módulo desconocido: ${id}`);
        setSetting(this.db, `module.${id}.enabled`, enabled ? '1' : '0');
        if (enabled) await this.start(id);
        else await this.stop(id);
        publish('modules:changed', this.list());
    }

    private async start(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry || entry.running) return;
        entry.cleanup = [];
        entry.error = undefined;

        const logger = new Logger(`Module:${id}`);
        const guard = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
            try {
                await fn(...args);
            } catch (err) {
                logger.error(`Error en un handler de "${id}"`, err);
            }
        };

        const ctx: ModuleContext = {
            client: this.client,
            db: this.db,
            logger,
            listen: (event, handler) => {
                const wrapped = guard(handler as (...args: unknown[]) => unknown);
                this.client.on(event, wrapped as never);
                entry.cleanup.push(() => this.client.off(event, wrapped as never));
            },
            every: (ms, fn) => {
                const t = setInterval(guard(fn), ms);
                entry.cleanup.push(() => clearInterval(t));
            },
            onStop: fn => entry.cleanup.push(fn),
        };

        try {
            await entry.mod.start(ctx);
            entry.running = true;
            this.logger.info(`🟢 Módulo activado: ${id}`);
        } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            this.logger.error(`No se pudo arrancar el módulo "${id}"`, err);
            await this.runCleanup(entry);
        }
    }

    private async stop(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry || !entry.running) return;
        entry.running = false;
        try {
            await entry.mod.stop?.();
        } catch (err) {
            this.logger.error(`Error al parar el módulo "${id}"`, err);
        }
        await this.runCleanup(entry);
        this.logger.info(`⚪ Módulo desactivado: ${id}`);
    }

    private async runCleanup(entry: Entry): Promise<void> {
        for (const fn of entry.cleanup.reverse()) {
            try {
                await fn();
            } catch (err) {
                this.logger.error('Error en limpieza de módulo', err);
            }
        }
        entry.cleanup = [];
    }
}
