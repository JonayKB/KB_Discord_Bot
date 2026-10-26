import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

/** Errores "esperables" del bot (módulo desactivado, datos inválidos…). */
export class BotError extends Error {}

export const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
    (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };

export function str(v: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string {
    const required = opts.required ?? false;
    if (v === undefined || v === null || v === '') {
        if (required) throw new HttpError(400, `Falta el campo "${field}"`);
        return '';
    }
    if (typeof v !== 'string') throw new HttpError(400, `"${field}" debe ser texto`);
    if (opts.max && v.length > opts.max) throw new HttpError(400, `"${field}" es demasiado largo (máx. ${opts.max})`);
    return v;
}

export function int(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw new HttpError(400, `"${field}" debe ser un número entero`);
    }
    if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `"${field}" debe ser ≥ ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw new HttpError(400, `"${field}" debe ser ≤ ${opts.max}`);
    return n;
}

export function bool(v: unknown): boolean {
    return v === true || v === 1 || v === '1' || v === 'true';
}

export function strArray(v: unknown, field: string, maxItems = 500): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        throw new HttpError(400, `"${field}" debe ser una lista de textos`);
    }
    if (v.length > maxItems) throw new HttpError(400, `"${field}" tiene demasiados elementos`);
    return v as string[];
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}
