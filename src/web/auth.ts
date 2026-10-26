import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Client } from 'discord.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../core/db';
import { env } from '../core/config';
import { asyncRoute } from '../core/http';
import { Logger } from '../utils/Logger';

const logger = new Logger('PanelAuth');

const SESSION_COOKIE = 'kb_session';
const STATE_COOKIE = 'kb_oauth_state';
const DISCORD_API = 'https://discord.com/api/v10';

export interface SessionUser {
    userId: string;
    username: string;
    avatar: string | null;
}

declare module 'express-serve-static-core' {
    interface Request {
        session?: SessionUser;
    }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

const secureCookies = env.panel.url.startsWith('https://');

function cookie(name: string, value: string, maxAgeSec: number): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies ? '; Secure' : ''}`;
}

export function sessionFromCookieHeader(db: DB, header: string | undefined): SessionUser | undefined {
    const token = parseCookies(header)[SESSION_COOKIE];
    if (!token) return undefined;
    const row = db.prepare('SELECT user_id, username, avatar, expires_at FROM sessions WHERE id = ?').get(sha256(token)) as
        | { user_id: string; username: string; avatar: string | null; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    return { userId: row.user_id, username: row.username, avatar: row.avatar };
}

export function sessionFromRequest(db: DB, req: IncomingMessage): SessionUser | undefined {
    return sessionFromCookieHeader(db, req.headers.cookie);
}

function createSession(db: DB, user: SessionUser): string {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (id, user_id, username, avatar, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        sha256(token), user.userId, user.username, user.avatar, Date.now() + env.panel.sessionHours * 3600_000
    );
    return token;
}

export function purgeExpiredSessions(db: DB): void {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/** ¿Este usuario de Discord puede entrar al panel? */
async function isAllowed(client: Client, userId: string): Promise<boolean> {
    if (env.panel.adminIds.includes(userId)) return true;
    if (!env.panel.roleIds.length) return false;
    const guild = client.guilds.cache.get(env.guildId);
    const member = await guild?.members.fetch(userId).catch(() => null);
    return !!member && env.panel.roleIds.some(r => member.roles.cache.has(r));
}

function loginPage(message: string): string {
    const esc = message.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    return `<!doctype html><meta charset="utf-8"><title>Acceso denegado</title>
<body style="font-family:system-ui;background:#111318;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h2>No se pudo iniciar sesión</h2><p>${esc}</p><p><a style="color:#8ab4ff" href="/">Volver</a></p></div></body>`;
}

export function createAuthRouter(db: DB, client: Client): Router {
    const router = Router();
    const redirectUri = `${env.panel.url}/auth/callback`;

    router.get('/login', (_req, res) => {
        if (!env.clientId || !env.panel.clientSecret) {
            res.status(500).send(loginPage('Falta CLIENT_ID o DISCORD_CLIENT_SECRET en el .env.'));
            return;
        }
        const state = crypto.randomBytes(16).toString('hex');
        res.setHeader('Set-Cookie', cookie(STATE_COOKIE, state, 600));
        const url = new URL('https://discord.com/oauth2/authorize');
        url.searchParams.set('client_id', env.clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', 'identify');
        url.searchParams.set('state', state);
        url.searchParams.set('prompt', 'none');
        res.redirect(url.toString());
    });

    router.get('/callback', asyncRoute(async (req: Request, res: Response) => {
        const { code, state } = req.query;
        const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
        if (typeof code !== 'string' || typeof state !== 'string' || !expected || state !== expected) {
            res.status(400).send(loginPage('La sesión de inicio ha caducado o no es válida. Inténtalo de nuevo.'));
            return;
        }
        try {
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: env.clientId,
                    client_secret: env.panel.clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri,
                }),
            });
            if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
            const { access_token } = (await tokenRes.json()) as { access_token: string };

            const meRes = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } });
            if (!meRes.ok) throw new Error(`users/@me HTTP ${meRes.status}`);
            const me = (await meRes.json()) as { id: string; username: string; global_name?: string; avatar?: string | null };

            if (!(await isAllowed(client, me.id))) {
                logger.warn(`🚫 Acceso denegado al panel para ${me.username} (${me.id})`);
                res.status(403).send(loginPage('Tu cuenta de Discord no tiene acceso a este panel.'));
                return;
            }

            const token = createSession(db, {
                userId: me.id,
                username: me.global_name ?? me.username,
                avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
            });
            logger.info(`🔓 ${me.username} ha iniciado sesión en el panel`);
            res.setHeader('Set-Cookie', [
                cookie(SESSION_COOKIE, token, env.panel.sessionHours * 3600),
                cookie(STATE_COOKIE, '', 0),
            ]);
            res.redirect('/');
        } catch (err) {
            logger.error('Error en el login con Discord', err);
            res.status(502).send(loginPage('No se pudo completar el inicio de sesión con Discord.'));
        }
    }));

    router.post('/logout', (req, res) => {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
        res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
        res.json({ ok: true });
    });

    if (env.panel.devAuth) {
        logger.warn('⚠️ PANEL_DEV_AUTH activo: /auth/dev-login permite entrar SIN Discord (solo para desarrollo).');
        router.get('/dev-login', (_req, res) => {
            const token = createSession(db, { userId: 'dev', username: 'Desarrollo', avatar: null });
            res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token, 3600));
            res.redirect('/');
        });
    }

    return router;
}

export function requireAuth(db: DB) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const session = sessionFromRequest(db, req);
        if (!session) {
            res.status(401).json({ error: 'No has iniciado sesión' });
            return;
        }
        req.session = session;
        next();
    };
}

/**
 * Protección CSRF: las peticiones que modifican datos deben llevar una cabecera personalizada.
 * Un sitio externo no puede añadirla sin pasar por CORS (que no está habilitado).
 */
export function requireCsrfHeader(req: Request, res: Response, next: NextFunction): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'kb-panel') {
        res.status(403).json({ error: 'Petición no permitida' });
        return;
    }
    next();
}
