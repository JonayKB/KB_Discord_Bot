import type { Client } from 'discord.js';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../core/config';
import type { DB } from '../core/db';
import { getSetting, setSetting } from '../core/db';
import { parseJson } from '../core/http';

/** owner: acceso total · staff: solo lo que aparece en STAFF_ROUTES. */
export type PanelAccess = 'owner' | 'staff';

const STAFF_ROLES_KEY = 'panel.staff_role_ids';

/**
 * Lista de permitidos del rol de administrador: lo que no esté aquí se rechaza, así las rutas
 * nuevas quedan reservadas al propietario hasta que se añadan expresamente.
 */
const STAFF_ROUTES: Record<string, RegExp[]> = {
    GET: [
        /^\/(me|status|logs|modules)$/,
        /^\/guild\/(members|roles|channels)$/,
        /^\/files\/[^/]+$/,
        /^\/messages\/(audience|history|templates)$/,
        /^\/messages\/batches\/[^/]+$/,
        /^\/inbox\/(conversations|settings)$/,
        /^\/inbox\/conversations\/[^/]+$/,
        /^\/moderation\/(config|cases|bans)$/,
        /^\/moderation\/users\/[^/]+$/,
        /^\/tickets$/,
        /^\/tickets\/\d+(\/transcript)?$/,
    ],
    POST: [
        /^\/files$/,
        /^\/messages\/send$/,
        /^\/inbox\/conversations\/[^/]+\/(read|reply)$/,
        /^\/moderation\/actions$/,
        /^\/tickets\/\d+\/(reply|claim|close)$/,
    ],
};

/** Eventos en directo que recibe el rol de administrador; el resto son de secciones que no ve. */
export const STAFF_EVENTS: ReadonlySet<string> = new Set([
    'log',
    'message:new',
    'message:deleted',
    'messages:active',
    'bulk:progress',
    'inbox:read',
    'moderation:cases',
    'modules:changed',
    'tickets:changed',
    'tickets:message',
]);

export function getStaffRoleIds(db: DB): string[] {
    return parseJson<string[]>(getSetting(db, STAFF_ROLES_KEY, ''), []);
}

export function setStaffRoleIds(db: DB, roleIds: string[]): void {
    setSetting(db, STAFF_ROLES_KEY, JSON.stringify([...new Set(roleIds)]));
}

/** Nivel de acceso actual de un usuario de Discord (null = sin acceso). Lee los roles en vivo. */
export async function resolveAccess(client: Client, db: DB, userId: string): Promise<PanelAccess | null> {
    if (env.panel.adminIds.includes(userId) || (env.panel.devAuth && userId === 'dev')) return 'owner';
    const staffRoles = getStaffRoleIds(db);
    if (!env.panel.roleIds.length && !staffRoles.length) return null;
    const guild = client.guilds.cache.get(env.guildId);
    const member = await guild?.members.fetch(userId).catch(() => null);
    if (!member) return null;
    if (env.panel.roleIds.some(r => member.roles.cache.has(r))) return 'owner';
    return staffRoles.some(r => member.roles.cache.has(r)) ? 'staff' : null;
}

export function requireStaffRoute(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.access === 'owner' || STAFF_ROUTES[req.method]?.some(r => r.test(req.path))) return next();
    res.status(403).json({ error: 'Tu rol no tiene acceso a esta función.' });
}
