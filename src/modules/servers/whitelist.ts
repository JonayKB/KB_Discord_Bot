import type { Client } from 'discord.js';
import type { DB } from '../../core/db';
import { publish } from '../../core/bus';
import { env } from '../../core/config';
import { HttpError } from '../../core/http';
import { Logger } from '../../utils/Logger';
import type { ConfirmationService } from '../confirmations/service';
import { rconRun, stripColors } from './rcon';
import type { ServersService } from './service';

const logger = new Logger('Whitelist');

/** Formato de nombre de Minecraft. Además de validar, impide colar otros comandos por RCON. */
export const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;

const MOJANG_API = (process.env.MOJANG_API_URL ?? 'https://api.mojang.com').replace(/\/+$/, '');
const MOJANG_SESSION = (process.env.MOJANG_SESSION_URL ?? 'https://sessionserver.mojang.com').replace(/\/+$/, '');

export interface WhitelistSettings {
    serverId: number;
    enabled: boolean;
    campaignId: number | null;
    onlineMode: boolean;
    allowRename: boolean;
    renameCooldownDays: number;
    removeOnLeave: boolean;
    /** Si es false, quien confirma en el formulario espera a que el staff lo apruebe (solo se avisa). */
    autoAdd: boolean;
}

/** `missing`: vinculado, pero ya no está en la whitelist real del servidor (lo quitaron a mano). */
export type EntryStatus = 'pending_add' | 'active' | 'missing' | 'pending_remove' | 'removed' | 'error';

export interface WhitelistEntry {
    id: number;
    serverId: number;
    userId: string;
    username: string | null;
    mcName: string;
    mcUuid: string | null;
    status: EntryStatus;
    preexisting: boolean;
    /** Alta pendiente de que el staff la apruebe (modo "solo avisar"). */
    awaiting: boolean;
    source: 'form' | 'panel' | 'import';
    addedBy: string | null;
    error: string | null;
    removedReason: string | null;
    createdAt: number;
    updatedAt: number;
}

interface SettingsRow { server_id: number; enabled: number; campaign_id: number | null; online_mode: number; allow_rename: number; rename_cooldown_days: number; remove_on_leave: number; auto_add: number }
interface EntryRow {
    id: number; server_id: number; user_id: string; username: string | null; mc_name: string; mc_uuid: string | null; status: EntryStatus;
    preexisting: number; awaiting: number; source: WhitelistEntry['source']; added_by: string | null; error: string | null; removed_reason: string | null; created_at: number; updated_at: number;
}

const toSettings = (r: SettingsRow): WhitelistSettings => ({
    serverId: r.server_id, enabled: !!r.enabled, campaignId: r.campaign_id, onlineMode: !!r.online_mode,
    allowRename: !!r.allow_rename, renameCooldownDays: r.rename_cooldown_days, removeOnLeave: !!r.remove_on_leave, autoAdd: !!r.auto_add,
});
const toEntry = (r: EntryRow): WhitelistEntry => ({
    id: r.id, serverId: r.server_id, userId: r.user_id, username: r.username, mcName: r.mc_name, mcUuid: r.mc_uuid, status: r.status,
    preexisting: !!r.preexisting, awaiting: !!r.awaiting, source: r.source, addedBy: r.added_by, error: r.error, removedReason: r.removed_reason, createdAt: r.created_at, updatedAt: r.updated_at,
});

const CURRENT = "status IN ('pending_add','active','missing')";
const HOLDS_NAME = "status IN ('pending_add','active','missing','pending_remove')";

export class WhitelistService {
    active = false;
    private timer: NodeJS.Timeout | undefined;
    private readonly running = new Map<number, Promise<void>>();
    private readonly lookupCache = new Map<string, { at: number; value: { name: string; uuid: string } | null }>();

    constructor(
        private readonly client: Client,
        private readonly db: DB,
        private readonly servers: ServersService,
        private readonly confirmations: ConfirmationService
    ) {
        confirmations.addHooks({
            validate: (campaignId, userId, answer, opts) => this.validateAnswer(campaignId, userId, answer, opts.fromPanel),
            confirmed: (campaignId, userId, answer, opts) => this.onConfirmed(campaignId, userId, answer, opts.fromPanel),
            removed: (campaignId, userId, reason) => this.onCampaignRemoved(campaignId, userId, reason),
        });
    }

    start(): void {
        this.active = true;
        clearInterval(this.timer);
        // Reintenta lo pendiente (p. ej. si el servidor estaba apagado).
        this.timer = setInterval(() => void this.processAll(), 60_000);
        void this.processAll();
    }

    stop(): void {
        this.active = false;
        clearInterval(this.timer);
        this.timer = undefined;
    }

    // ────────────────────────── RCON ──────────────────────────

    rconInfo(serverId: number): { port: number | null; hasPassword: boolean } {
        const r = this.db.prepare('SELECT rcon_port, rcon_password FROM game_servers WHERE id = ?').get(serverId) as { rcon_port: number | null; rcon_password: string | null } | undefined;
        return { port: r?.rcon_port ?? null, hasPassword: !!r?.rcon_password };
    }

    /** Guarda el puerto y (si se envía) la contraseña. La contraseña nunca se devuelve al panel. */
    setRcon(serverId: number, port: number | null, password: string | undefined): { port: number | null; hasPassword: boolean } {
        const s = this.servers.require(serverId);
        if (s.type !== 'minecraft') throw new HttpError(400, 'RCON solo está disponible para servidores de Minecraft.');
        if (password !== undefined) this.db.prepare('UPDATE game_servers SET rcon_port = ?, rcon_password = ? WHERE id = ?').run(port, password || null, serverId);
        else this.db.prepare('UPDATE game_servers SET rcon_port = ? WHERE id = ?').run(port, serverId);
        publish('servers:changed', { id: serverId });
        if (this.active) void this.process(serverId);
        return this.rconInfo(serverId);
    }

    async run(serverId: number, commands: string[]): Promise<string[]> {
        const s = this.servers.require(serverId);
        const r = this.db.prepare('SELECT rcon_port, rcon_password FROM game_servers WHERE id = ?').get(serverId) as { rcon_port: number | null; rcon_password: string | null };
        if (!r.rcon_port || !r.rcon_password) throw new HttpError(400, 'Configura primero el puerto y la contraseña de RCON.');
        try {
            return (await rconRun(s.host, r.rcon_port, r.rcon_password, commands)).map(stripColors);
        } catch (err) {
            throw new HttpError(400, (err as Error).message);
        }
    }

    /** Consola del panel: un comando suelto. */
    async console(serverId: number, command: string, by: string): Promise<string> {
        const cmd = command.trim().replace(/^\//, '');
        if (!cmd) throw new HttpError(400, 'Escribe un comando.');
        if (/[\r\n]/.test(cmd)) throw new HttpError(400, 'Un solo comando por línea.');
        logger.info(`⌨️ RCON en "${this.servers.require(serverId).name}" por ${by}: ${cmd}`);
        const [out] = await this.run(serverId, [cmd]);
        return out;
    }

    /** Nombres que hay ahora mismo en la whitelist del servidor. */
    async serverList(serverId: number): Promise<string[]> {
        const [out] = await this.run(serverId, ['whitelist list']);
        if (/no whitelisted|there are 0 /i.test(out)) return [];
        const m = /:\s*(.*)$/s.exec(out);
        // Si no entendemos la respuesta, mejor fallar que creer que la whitelist está vacía.
        if (!m) throw new Error(`Respuesta inesperada a "whitelist list": ${out.slice(0, 120)}`);
        return m[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    }

    // ────────────────────────── Configuración ──────────────────────────

    settings(serverId: number): WhitelistSettings {
        const r = this.db.prepare('SELECT * FROM whitelist_settings WHERE server_id = ?').get(serverId) as SettingsRow | undefined;
        return r ? toSettings(r) : { serverId, enabled: false, campaignId: null, onlineMode: true, allowRename: false, renameCooldownDays: 30, removeOnLeave: true, autoAdd: true };
    }

    setSettings(s: WhitelistSettings): WhitelistSettings {
        const server = this.servers.require(s.serverId);
        if (server.type !== 'minecraft') throw new HttpError(400, 'La whitelist por RCON solo está disponible para Minecraft.');
        if (s.enabled && !s.campaignId) throw new HttpError(400, 'Elige de qué campaña de confirmación salen los nombres.');
        if (s.campaignId) this.confirmations.requireCampaign(s.campaignId);
        this.db.prepare(`
            INSERT INTO whitelist_settings (server_id, enabled, campaign_id, online_mode, allow_rename, rename_cooldown_days, remove_on_leave, auto_add)
            VALUES (@serverId, @enabled, @campaignId, @onlineMode, @allowRename, @renameCooldownDays, @removeOnLeave, @autoAdd)
            ON CONFLICT (server_id) DO UPDATE SET enabled = excluded.enabled, campaign_id = excluded.campaign_id, online_mode = excluded.online_mode,
                allow_rename = excluded.allow_rename, rename_cooldown_days = excluded.rename_cooldown_days, remove_on_leave = excluded.remove_on_leave,
                auto_add = excluded.auto_add
        `).run({ ...s, enabled: s.enabled ? 1 : 0, onlineMode: s.onlineMode ? 1 : 0, allowRename: s.allowRename ? 1 : 0, removeOnLeave: s.removeOnLeave ? 1 : 0, autoAdd: s.autoAdd ? 1 : 0 });
        publish('whitelist:changed', { serverId: s.serverId });
        // Al volver a activar el modo automático, se aplica lo que estaba esperando.
        if (s.autoAdd && this.active) void this.process(s.serverId).catch(() => undefined);
        return this.settings(s.serverId);
    }

    private enabledFor(campaignId: number): WhitelistSettings[] {
        return (this.db.prepare('SELECT * FROM whitelist_settings WHERE enabled = 1 AND campaign_id = ?').all(campaignId) as SettingsRow[]).map(toSettings);
    }

    entries(serverId: number, includeRemoved = false): WhitelistEntry[] {
        const where = includeRemoved ? '' : "AND status != 'removed'";
        return (this.db.prepare(`SELECT * FROM whitelist_entries WHERE server_id = ? ${where} ORDER BY updated_at DESC LIMIT 1000`).all(serverId) as EntryRow[]).map(toEntry);
    }

    private current(serverId: number, userId: string): WhitelistEntry | null {
        const r = this.db.prepare(`SELECT * FROM whitelist_entries WHERE server_id = ? AND user_id = ? AND ${CURRENT}`).get(serverId, userId) as EntryRow | undefined;
        return r ? toEntry(r) : null;
    }

    // ────────────────────────── Reglas ──────────────────────────

    /** Comprueba con Mojang que la cuenta existe y devuelve su nombre exacto y UUID. */
    async lookup(name: string): Promise<{ name: string; uuid: string } | null> {
        const key = name.toLowerCase();
        const hit = this.lookupCache.get(key);
        if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
        let res: Response;
        try {
            res = await fetch(`${MOJANG_API}/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
        } catch {
            throw new HttpError(503, 'No se pudo comprobar el nombre con Mojang ahora mismo. Inténtalo de nuevo en un rato.');
        }
        let value: { name: string; uuid: string } | null = null;
        if (res.status === 200) {
            const j = await res.json() as { id?: string; name?: string };
            if (j.id && j.name) value = { name: j.name, uuid: j.id.replace(/-/g, '').toLowerCase() };
        } else if (res.status !== 204 && res.status !== 404) {
            throw new HttpError(503, 'No se pudo comprobar el nombre con Mojang ahora mismo. Inténtalo de nuevo en un rato.');
        }
        this.lookupCache.set(key, { at: Date.now(), value });
        return value;
    }

    /** Nombre actual de una cuenta (por si la persona se lo cambió en Minecraft). */
    private async currentName(uuid: string): Promise<string | null> {
        try {
            const res = await fetch(`${MOJANG_SESSION}/session/minecraft/profile/${uuid}`, { signal: AbortSignal.timeout(6000) });
            if (res.status !== 200) return null;
            const j = await res.json() as { name?: string };
            return j.name && MC_NAME.test(j.name) ? j.name : null;
        } catch {
            return null;
        }
    }

    /**
     * Aplica todas las reglas a "este usuario quiere este nombre en este servidor".
     * Devuelve el nombre exacto (y UUID) o lanza un error explicando por qué no.
     */
    async check(serverId: number, userId: string, rawName: string, opts: { fromPanel: boolean }): Promise<{ name: string; uuid: string | null; unchanged: boolean }> {
        const settings = this.settings(serverId);
        const serverName = this.servers.require(serverId).name;
        const typed = rawName.trim();
        if (!MC_NAME.test(typed)) throw new HttpError(400, `"${typed.slice(0, 40)}" no es un nombre de Minecraft válido (3-16 letras, números o _).`);

        let name = typed;
        let uuid: string | null = null;
        if (settings.onlineMode) {
            const found = await this.lookup(typed);
            if (!found) throw new HttpError(400, `No existe ninguna cuenta de Minecraft llamada "${typed}". Revisa cómo se escribe.`);
            ({ name, uuid } = found);
        }

        const holder = this.db.prepare(`
            SELECT * FROM whitelist_entries WHERE server_id = ? AND user_id != ? AND ${HOLDS_NAME}
              AND (lower(mc_name) = lower(?) OR (? IS NOT NULL AND mc_uuid = ?)) LIMIT 1
        `).get(serverId, userId, name, uuid, uuid) as EntryRow | undefined;
        if (holder) {
            throw new HttpError(400, opts.fromPanel
                ? `"${name}" ya está registrado en ${serverName} por ${holder.username ?? holder.user_id}.`
                : `El nombre "${name}" ya lo tiene registrado otra persona. Si es tu cuenta, abre un ticket y el staff lo revisará.`);
        }

        const cur = this.current(serverId, userId);
        const same = !!cur && (cur.mcName.toLowerCase() === name.toLowerCase() || (!!uuid && cur.mcUuid === uuid));
        if (cur && !same && !opts.fromPanel) {
            if (!settings.allowRename) {
                throw new HttpError(400, `Ya tienes registrado "${cur.mcName}" en ${serverName}. Para cambiarlo, abre un ticket y el staff lo hará.`);
            }
            const next = cur.createdAt + settings.renameCooldownDays * 86_400_000;
            if (Date.now() < next) {
                throw new HttpError(400, `Solo puedes cambiar tu nombre en ${serverName} cada ${settings.renameCooldownDays} días. Podrás a partir del ${new Date(next).toLocaleDateString('es-ES')}.`);
            }
        }
        return { name, uuid, unchanged: same };
    }

    /**
     * Registra el nombre: si el usuario ya tenía otro, el viejo pasa a "por quitar" en la misma
     * transacción, así nunca tiene dos a la vez. Después se aplica por RCON.
     */
    register(serverId: number, userId: string, name: string, uuid: string | null, source: WhitelistEntry['source'], addedBy: string | null): WhitelistEntry {
        if (!MC_NAME.test(name)) throw new HttpError(400, 'Nombre no válido.');
        const now = Date.now();
        const user = this.client.guilds.cache.get(env.guildId)?.members.cache.get(userId)?.user;
        // Lo que llega del formulario espera aprobación si el modo automático está apagado; lo que hace el staff, no.
        const awaiting = source === 'form' && !this.settings(serverId).autoAdd;
        const id = this.db.transaction(() => {
            const cur = this.current(serverId, userId);
            const isSame = (e: WhitelistEntry) => e.mcName.toLowerCase() === name.toLowerCase() || (!!uuid && e.mcUuid === uuid);
            if (cur && isSame(cur)) {
                // Si lo habían quitado a mano del servidor, se vuelve a añadir.
                if (cur.status === 'missing') this.requeue(cur.id, name, uuid, awaiting);
                // Si el staff registra a quien esperaba aprobación, queda aprobado.
                else if (cur.awaiting && !awaiting) this.db.prepare('UPDATE whitelist_entries SET awaiting = 0, added_by = coalesce(?, added_by), updated_at = ? WHERE id = ?').run(addedBy, now, cur.id);
                return cur.id;
            }
            if (cur) this.retire(cur, 'Cambio de nombre');
            // Su mismo nombre aún se está quitando (p. ej. justo lo borraron del panel): se cancela la baja
            // en vez de crear otra fila con el mismo nombre (lo impediría el índice único).
            const leaving = this.db.prepare(`
                SELECT * FROM whitelist_entries WHERE server_id = ? AND user_id = ? AND status = 'pending_remove'
                  AND (lower(mc_name) = lower(?) OR (? IS NOT NULL AND mc_uuid = ?)) LIMIT 1
            `).get(serverId, userId, name, uuid, uuid) as EntryRow | undefined;
            if (leaving) {
                // Las bajas solo se envían dentro de process(): si no hay ninguno en marcha, sigue en el
                // servidor y basta con volver a "activo". Si lo hay, puede estar quitándose ahora mismo:
                // se pone en cola para añadirlo otra vez (la baja en curso ya no lo marcará como quitado).
                if (this.running.has(serverId)) this.requeue(leaving.id, name, uuid, awaiting);
                else this.db.prepare(`UPDATE whitelist_entries SET status = 'active', mc_name = ?, mc_uuid = coalesce(?, mc_uuid), error = NULL, removed_reason = NULL, updated_at = ? WHERE id = ?`)
                    .run(name, uuid, now, leaving.id);
                return leaving.id;
            }
            return Number(this.db.prepare(`
                INSERT INTO whitelist_entries (server_id, user_id, username, mc_name, mc_uuid, status, awaiting, source, added_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending_add', ?, ?, ?, ?, ?)
            `).run(serverId, userId, user?.username ?? null, name, uuid, awaiting ? 1 : 0, source, addedBy, now, now).lastInsertRowid);
        })();
        const saved = toEntry(this.db.prepare('SELECT * FROM whitelist_entries WHERE id = ?').get(id) as EntryRow);
        if (saved.awaiting && saved.status === 'pending_add') {
            logger.info(`📝 ${saved.mcName} (${saved.username ?? userId}) pide entrar en la whitelist de "${this.servers.get(serverId)?.name}": esperando aprobación en el panel`);
        }
        publish('whitelist:changed', { serverId });
        return saved;
    }

    /** Vuelve a poner una entrada en cola para añadirla al servidor. */
    private requeue(id: number, name: string, uuid: string | null, awaiting = false): void {
        this.db.prepare(`UPDATE whitelist_entries SET status = 'pending_add', awaiting = ?, mc_name = ?, mc_uuid = coalesce(?, mc_uuid), error = NULL, removed_reason = NULL, updated_at = ? WHERE id = ?`)
            .run(awaiting ? 1 : 0, name, uuid, Date.now(), id);
    }

    /**
     * Marca un nombre para quitarlo. Si nunca llegó a añadirse, ya estaba antes o ya no está en el
     * servidor, se cierra sin tocar el servidor.
     */
    private retire(e: WhitelistEntry, reason: string): void {
        const status: EntryStatus = e.status === 'pending_add' || e.status === 'missing' || e.preexisting ? 'removed' : 'pending_remove';
        this.db.prepare('UPDATE whitelist_entries SET status = ?, removed_reason = ?, error = NULL, updated_at = ? WHERE id = ?').run(status, reason, Date.now(), e.id);
    }

    unregister(serverId: number, userId: string, reason: string): boolean {
        const cur = this.current(serverId, userId);
        if (!cur) return false;
        this.retire(cur, reason);
        publish('whitelist:changed', { serverId });
        logger.info(`➖ ${cur.mcName} (${cur.username ?? userId}) saldrá de la whitelist de "${this.servers.get(serverId)?.name}": ${reason}`);
        if (this.active) void this.process(serverId);
        return true;
    }

    removeEntry(entryId: number, by: string): void {
        const r = this.db.prepare('SELECT * FROM whitelist_entries WHERE id = ?').get(entryId) as EntryRow | undefined;
        if (!r) throw new HttpError(404, 'Entrada no encontrada');
        const e = toEntry(r);
        if (e.status === 'removed' || e.status === 'error') {
            this.db.prepare('DELETE FROM whitelist_entries WHERE id = ?').run(entryId); // limpiar historial
        } else if (e.status === 'pending_remove') {
            throw new HttpError(400, 'Ya se está quitando.');
        } else {
            this.retire(e, `Quitado desde el panel por ${by}`);
            if (this.active) void this.process(e.serverId);
        }
        publish('whitelist:changed', { serverId: e.serverId });
    }

    /** El staff añade al servidor a quien esperaba aprobación o a quien quitaron a mano. */
    async approve(entryId: number, by: string): Promise<WhitelistEntry> {
        const r = this.db.prepare('SELECT * FROM whitelist_entries WHERE id = ?').get(entryId) as EntryRow | undefined;
        if (!r) throw new HttpError(404, 'Entrada no encontrada');
        if (r.status !== 'missing' && !(r.status === 'pending_add' && r.awaiting)) {
            throw new HttpError(400, 'Solo se puede añadir a quien espera aprobación o ya no está en la whitelist del servidor.');
        }
        this.requeue(r.id, r.mc_name, r.mc_uuid);
        this.db.prepare('UPDATE whitelist_entries SET added_by = ? WHERE id = ?').run(by, r.id);
        logger.info(`✅ ${r.mc_name} (${r.username ?? r.user_id}) se añade a la whitelist por ${by}`);
        publish('whitelist:changed', { serverId: r.server_id });
        await this.process(r.server_id).catch(() => undefined);
        return toEntry(this.db.prepare('SELECT * FROM whitelist_entries WHERE id = ?').get(entryId) as EntryRow);
    }

    /** Alta desde el panel (el staff puede cambiar el nombre aunque el usuario no pueda). */
    async addFromPanel(serverId: number, userId: string, rawName: string, by: string): Promise<WhitelistEntry> {
        const { name, uuid } = await this.check(serverId, userId, rawName, { fromPanel: true });
        const e = this.register(serverId, userId, name, uuid, 'panel', by);
        // Mantiene la respuesta de la campaña igual que el nombre de la whitelist.
        const s = this.settings(serverId);
        if (s.campaignId) this.db.prepare("UPDATE confirmations SET answer = ?, updated_at = ? WHERE campaign_id = ? AND user_id = ? AND status = 'confirmed'").run(name, Date.now(), s.campaignId, userId);
        await this.process(serverId).catch(() => undefined);
        return toEntry(this.db.prepare('SELECT * FROM whitelist_entries WHERE id = ?').get(e.id) as EntryRow);
    }

    /** Añade a todos los confirmados de la campaña que aún no estén (para empezar a usarlo con gente que ya respondió). */
    async importConfirmed(serverId: number, by: string): Promise<{ added: number; unchanged: number; skipped: Array<{ user: string; name: string; reason: string }> }> {
        const s = this.settings(serverId);
        if (!s.campaignId) throw new HttpError(400, 'Elige primero la campaña en los ajustes de la whitelist.');
        const rows = this.db.prepare(`
            SELECT user_id, username, answer FROM confirmations
            WHERE campaign_id = ? AND status = 'confirmed' AND answer IS NOT NULL AND user_id NOT LIKE 'legacy:%' ORDER BY created_at
        `).all(s.campaignId) as Array<{ user_id: string; username: string | null; answer: string }>;
        const out = { added: 0, unchanged: 0, skipped: [] as Array<{ user: string; name: string; reason: string }> };
        const guild = this.client.guilds.cache.get(env.guildId);
        for (const r of rows) {
            if (guild && !guild.members.cache.has(r.user_id)) {
                out.skipped.push({ user: r.username ?? r.user_id, name: r.answer, reason: 'Ya no está en el servidor de Discord.' });
                continue;
            }
            try {
                const c = await this.check(serverId, r.user_id, r.answer, { fromPanel: false });
                // Ya lo tiene: salvo que lo hayan quitado a mano o esté esperando aprobación (importar lo aprueba).
                const cur = this.current(serverId, r.user_id);
                if (c.unchanged && cur?.status !== 'missing' && !cur?.awaiting) { out.unchanged++; continue; }
                this.register(serverId, r.user_id, c.name, c.uuid, 'import', by);
                out.added++;
            } catch (err) {
                out.skipped.push({ user: r.username ?? r.user_id, name: r.answer, reason: (err as Error).message });
            }
        }
        await this.process(serverId).catch(() => undefined);
        return out;
    }

    // ────────────────────────── Ganchos de confirmaciones / Discord ──────────────────────────

    private async validateAnswer(campaignId: number, userId: string, answer: string, fromPanel: boolean): Promise<{ error?: string; answer?: string }> {
        let canonical: string | undefined;
        for (const s of this.enabledFor(campaignId)) {
            try {
                const c = await this.check(s.serverId, userId, answer, { fromPanel });
                canonical ??= c.name;
            } catch (err) {
                return { error: (err as Error).message };
            }
        }
        return { answer: canonical };
    }

    private async onConfirmed(campaignId: number, userId: string, answer: string, fromPanel: boolean): Promise<string[]> {
        const notes: string[] = [];
        for (const s of this.enabledFor(campaignId)) {
            const server = this.servers.require(s.serverId);
            const c = await this.check(s.serverId, userId, answer, { fromPanel });
            const e = this.register(s.serverId, userId, c.name, c.uuid, fromPanel ? 'panel' : 'form', null);
            if (this.active) await this.process(s.serverId).catch(() => undefined);
            const now = this.db.prepare('SELECT status, error FROM whitelist_entries WHERE id = ?').get(e.id) as { status: EntryStatus; error: string | null };
            if (now.status === 'active') notes.push(`✅ Estás en la whitelist de **${server.name}** como \`${c.name}\`.`);
            else if (e.awaiting) notes.push(`📝 Tu solicitud para entrar en **${server.name}** como \`${c.name}\` está registrada. El staff te añadirá a la whitelist.`);
            else if (now.status === 'error') notes.push(`⚠️ El servidor ${server.name} no aceptó \`${c.name}\`: ${now.error}. Avisa al staff.`);
            else notes.push(`⏳ Te añadiré a la whitelist de **${server.name}** como \`${c.name}\` en cuanto el servidor esté disponible.`);
        }
        return notes;
    }

    private async onCampaignRemoved(campaignId: number, userId: string, reason: string): Promise<void> {
        for (const s of this.enabledFor(campaignId)) this.unregister(s.serverId, userId, reason);
    }

    onMemberLeave(userId: string): void {
        const rows = this.db.prepare(`
            SELECT e.server_id FROM whitelist_entries e JOIN whitelist_settings w ON w.server_id = e.server_id
            WHERE e.user_id = ? AND e.${CURRENT} AND w.enabled = 1 AND w.remove_on_leave = 1
        `).all(userId) as Array<{ server_id: number }>;
        for (const r of rows) this.unregister(r.server_id, userId, 'Ha salido del servidor de Discord');
    }

    // ────────────────────────── Aplicar por RCON ──────────────────────────

    async processAll(): Promise<void> {
        if (!this.active) return;
        // Solo los servidores con altas o bajas por aplicar, para no conectarse por RCON sin necesidad.
        // Las altas que esperan aprobación (modo "solo avisar") no cuentan: no hay nada que hacer hasta que se aprueben.
        // La comprobación de quién sigue en la whitelist real se hace de paso, o con el botón "Sincronizar".
        const ids = (this.db.prepare(`
            SELECT DISTINCT e.server_id FROM whitelist_entries e LEFT JOIN whitelist_settings w ON w.server_id = e.server_id
            WHERE e.status = 'pending_remove' OR (e.status = 'pending_add' AND NOT (e.awaiting = 1 AND coalesce(w.auto_add, 1) = 0))
        `).all() as Array<{ server_id: number }>).map(r => r.server_id);
        for (const id of ids) await this.process(id).catch(err => logger.warn(`Whitelist de ${id}: ${(err as Error).message}`));
    }

    /** Aplica lo pendiente de un servidor. Nunca hay dos ejecuciones a la vez para el mismo servidor. */
    process(serverId: number): Promise<void> {
        const prev = this.running.get(serverId) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(() => this.doProcess(serverId));
        this.running.set(serverId, next);
        void next.finally(() => { if (this.running.get(serverId) === next) this.running.delete(serverId); }).catch(() => undefined);
        return next;
    }

    private async doProcess(serverId: number): Promise<void> {
        const pending = (this.db.prepare("SELECT * FROM whitelist_entries WHERE server_id = ? AND status IN ('pending_add','pending_remove') ORDER BY status DESC, id").all(serverId) as EntryRow[]).map(toEntry);
        const linked = (this.db.prepare("SELECT * FROM whitelist_entries WHERE server_id = ? AND status IN ('active','missing')").all(serverId) as EntryRow[]).map(toEntry);
        if ((!pending.length && !linked.length) || !this.servers.get(serverId)) return;
        const setError = (ids: number[], msg: string) => {
            const st = this.db.prepare('UPDATE whitelist_entries SET error = ?, updated_at = ? WHERE id = ?');
            for (const id of ids) st.run(msg, Date.now(), id);
        };

        let onServer: Set<string>;
        try {
            onServer = new Set((await this.serverList(serverId)).map(n => n.toLowerCase()));
        } catch (err) {
            if (pending.length) {
                setError(pending.map(p => p.id), (err as Error).message);
                publish('whitelist:changed', { serverId });
            }
            return;
        }

        // Sincroniza con la whitelist real: quien deja de aparecer pasa a "no está" y quien vuelve, a activo.
        // El cambio solo se aplica si la fila sigue en el mismo estado (no pisa lo que se haya hecho mientras).
        const flip = this.db.prepare('UPDATE whitelist_entries SET status = ?, error = NULL, updated_at = ? WHERE id = ? AND status = ?');
        let changed = pending.length > 0;
        for (const e of linked) {
            const there = onServer.has(e.mcName.toLowerCase());
            if (e.status === 'active' && !there) {
                if (flip.run('missing', Date.now(), e.id, 'active').changes) {
                    changed = true;
                    logger.warn(`⚠️ ${e.mcName} (${e.username ?? e.userId}) ya no está en la whitelist de "${this.servers.get(serverId)?.name}" (¿lo quitaron a mano?)`);
                }
            } else if (e.status === 'missing' && there) {
                if (flip.run('active', Date.now(), e.id, 'missing').changes) changed = true;
            }
        }
        if (!pending.length) {
            if (changed) publish('whitelist:changed', { serverId });
            return;
        }

        const settings = this.settings(serverId);
        // Solo si sigue en el estado en que se leyó: si mientras tanto se canceló la baja (o el alta), no se pisa.
        const update = this.db.prepare('UPDATE whitelist_entries SET status = ?, mc_name = ?, preexisting = ?, error = ?, awaiting = 0, updated_at = ? WHERE id = ? AND status = ?');
        // Primero las bajas (así un cambio de nombre nunca deja dos nombres a la vez).
        for (const e of pending.filter(p => p.status === 'pending_remove')) {
            let name = e.mcName;
            if (settings.onlineMode && e.mcUuid) name = (await this.currentName(e.mcUuid)) ?? name;
            if (!MC_NAME.test(name)) { setError([e.id], 'Nombre no válido'); continue; }
            try {
                const [out] = await this.run(serverId, [`whitelist remove ${name}`]);
                if (/removed|not whitelisted|isn't whitelisted|is not whitelisted|not on the whitelist/i.test(out)) {
                    update.run('removed', e.mcName, e.preexisting ? 1 : 0, null, Date.now(), e.id, 'pending_remove');
                    logger.info(`➖ ${name} quitado de la whitelist (${e.removedReason ?? ''})`);
                } else setError([e.id], out || 'Respuesta inesperada del servidor');
            } catch (err) {
                setError([e.id], (err as Error).message);
            }
        }
        for (const e of pending.filter(p => p.status === 'pending_add')) {
            // Modo "solo avisar": no se añade hasta que el staff lo apruebe (si ya está en el servidor, se vincula).
            const waits = e.awaiting && !settings.autoAdd;
            if (waits && !onServer.has(e.mcName.toLowerCase())) continue;
            if (!MC_NAME.test(e.mcName)) { update.run('error', e.mcName, 0, 'Nombre no válido', Date.now(), e.id, 'pending_add'); continue; }
            if (onServer.has(e.mcName.toLowerCase())) {
                // Ya estaba (lo puso alguien a mano): se vincula, pero el bot nunca lo quitará.
                update.run('active', e.mcName, 1, null, Date.now(), e.id, 'pending_add');
                continue;
            }
            try {
                const [out] = await this.run(serverId, [`whitelist add ${e.mcName}`]);
                if (/added|already/i.test(out)) {
                    update.run('active', e.mcName, 0, null, Date.now(), e.id, 'pending_add');
                    logger.info(`➕ ${e.mcName} (${e.username ?? e.userId}) añadido a la whitelist`);
                } else if (/does not exist|doesn't exist|unknown|could not|couldn't/i.test(out)) {
                    update.run('error', e.mcName, 0, out, Date.now(), e.id, 'pending_add');
                } else setError([e.id], out || 'Respuesta inesperada del servidor');
            } catch (err) {
                setError([e.id], (err as Error).message);
            }
        }
        publish('whitelist:changed', { serverId });
    }
}
