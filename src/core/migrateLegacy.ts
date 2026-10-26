import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db';
import { DATA_DIR, getSetting, setSetting } from './db';
import { env } from './config';
import { Logger } from '../utils/Logger';

const logger = new Logger('LegacyMigration');

/**
 * Valores que antes estaban escritos a mano en el código (index.ts / onDeniedConfirmationReceived.ts).
 * Ahora se guardan en la campaña y se editan desde el panel.
 */
const LEGACY_ROL_NOT_TO_SEND_ID = '1371833331800346725';
const LEGACY_ROL_IGNORE_ID = '1448303235285909605';

function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) as T;
    } catch {
        return null;
    }
}

/**
 * Se ejecuta una sola vez: convierte la configuración antigua (config.json, names.json,
 * denied_reasons.json y el cron fijo de las 14:00) en una campaña + programación editables.
 * No borra ni modifica los archivos antiguos.
 */
export function migrateLegacy(db: DB): void {
    if (getSetting(db, 'migrated.legacy_v1', '0') === '1') return;

    const cfg = readJson<Record<string, string>>('config.json') ?? {};
    const names = readJson<Record<string, string>>('names.json') ?? {};
    const denied = readJson<Record<string, string>>('denied_reasons.json') ?? {};
    const now = Date.now();

    db.transaction(() => {
        const res = db.prepare(`
            INSERT INTO campaigns (name, enabled, title, description, color, confirm_label, deny_label, input_label, allow_deny,
                confirmed_role_id, denied_role_id, exclude_role_ids, skip_responded, send_on_join, set_nickname, nickname_template,
                counter_title, counter_channel_id, counter_message_id, legacy, created_at)
            VALUES (?, 1, ?, ?, '#3B82F6', 'Abrir formulario', 'No deseo participar', 'Escribe tu nombre de usuario en Minecraft', 1,
                ?, ?, ?, 1, 1, 1, '{global} ({answer})', '📊 Cantidad de Personas QUE HAN CONFIRMADO:', ?, ?, 1, ?)
        `).run(
            'Confirmación Minecraft',
            '✨ Confirmación de Participación',
            'Para unirte al servidor de **MINECRAFT**, completa el formulario usando el botón de abajo.\n\n**Requisito:** Usuario de MINECRAFT.',
            cfg.rolContadoID || cfg.ROL_CONTADO_ID || null,
            LEGACY_ROL_IGNORE_ID,
            JSON.stringify([LEGACY_ROL_NOT_TO_SEND_ID, LEGACY_ROL_IGNORE_ID]),
            cfg.canalID || null,
            cfg.mensajeID || null,
            now
        );
        const campaignId = Number(res.lastInsertRowid);

        const insert = db.prepare(`
            INSERT OR IGNORE INTO confirmations (campaign_id, user_id, username, display_name, answer, status, reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [username, mcName] of Object.entries(names)) {
            insert.run(campaignId, `legacy:${username}`, username, username, mcName, 'confirmed', null, now, now);
        }
        for (const [username, reason] of Object.entries(denied)) {
            insert.run(campaignId, `legacy:${username}`, username, username, null, 'denied', reason, now, now);
        }

        // Antes el envío estaba fijo en el código: cada día a las 14:00.
        db.prepare(`
            INSERT INTO jobs (name, enabled, schedule_type, schedule, start_at, timezone, action_type, action_json, created_at, updated_at)
            VALUES (?, 1, 'cron', '0 14 * * *', NULL, ?, 'send_campaign', ?, ?, ?)
        `).run('Envío diario de la confirmación', env.timezone, JSON.stringify({ campaignId }), now, now);

        setSetting(db, 'migrated.legacy_v1', '1');
    })();

    logger.info(`✅ Migración inicial: campaña creada con ${Object.keys(names).length} confirmados y ${Object.keys(denied).length} rechazos importados.`);
}
