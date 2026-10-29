import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

export const DATA_DIR = path.join(process.cwd(), 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

/**
 * Migraciones: cada elemento se aplica una sola vez, en orden.
 * Para cambiar el esquema en el futuro, AÑADE un elemento nuevo (no edites los anteriores).
 */
const MIGRATIONS: string[] = [
    /* v1 */ `
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE files (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
        size       INTEGER NOT NULL DEFAULT 0,
        path       TEXT,               -- archivo guardado en data/uploads (si lo hay)
        url        TEXT,               -- URL externa (si no se pudo descargar)
        created_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind         TEXT NOT NULL CHECK (kind IN ('dm','channel')),
        user_id      TEXT,
        user_tag     TEXT,
        user_avatar  TEXT,
        channel_id   TEXT,
        channel_name TEXT,
        discord_id   TEXT,
        content      TEXT NOT NULL DEFAULT '',
        embed_json   TEXT,
        source       TEXT NOT NULL DEFAULT 'manual',
        source_ref   TEXT,
        status       TEXT NOT NULL DEFAULT 'sent',
        error        TEXT,
        read_at      INTEGER,
        created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_user    ON messages (user_id, id);
    CREATE INDEX idx_messages_created ON messages (created_at);

    CREATE TABLE message_files (
        message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        file_id    TEXT    NOT NULL REFERENCES files (id),
        PRIMARY KEY (message_id, file_id)
    );

    CREATE TABLE templates (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        content    TEXT NOT NULL DEFAULT '',
        embed_json TEXT,
        file_ids   TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron','interval','once')),
        schedule      TEXT NOT NULL,      -- cron: expresión | interval: segundos | once: ISO
        start_at      INTEGER,            -- ancla del intervalo (ms)
        timezone      TEXT,
        action_type   TEXT NOT NULL CHECK (action_type IN ('send_template','send_campaign')),
        action_json   TEXT NOT NULL,
        last_run_at   INTEGER,
        last_status   TEXT,
        last_result   TEXT,
        run_count     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );

    CREATE TABLE campaigns (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        title             TEXT NOT NULL,
        description       TEXT NOT NULL,
        color             TEXT NOT NULL DEFAULT '#3B82F6',
        confirm_label     TEXT NOT NULL DEFAULT 'Abrir formulario',
        deny_label        TEXT NOT NULL DEFAULT 'No deseo participar',
        input_label       TEXT NOT NULL DEFAULT 'Escribe tu nombre de usuario',
        allow_deny        INTEGER NOT NULL DEFAULT 1,
        confirmed_role_id TEXT,
        denied_role_id    TEXT,
        exclude_role_ids  TEXT NOT NULL DEFAULT '[]',
        skip_responded    INTEGER NOT NULL DEFAULT 1,
        send_on_join      INTEGER NOT NULL DEFAULT 1,
        set_nickname      INTEGER NOT NULL DEFAULT 1,
        nickname_template TEXT NOT NULL DEFAULT '{global} ({answer})',
        counter_title     TEXT NOT NULL DEFAULT '📊 Cantidad de Personas QUE HAN CONFIRMADO:',
        counter_channel_id TEXT,
        counter_message_id TEXT,
        legacy            INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
    );

    CREATE TABLE confirmations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id  INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        username     TEXT,
        display_name TEXT,
        answer       TEXT,
        status       TEXT NOT NULL CHECK (status IN ('confirmed','denied')),
        reason       TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE (campaign_id, user_id)
    );

    CREATE TABLE sessions (
        id         TEXT PRIMARY KEY,      -- sha256 del token de la cookie
        user_id    TEXT NOT NULL,
        username   TEXT NOT NULL,
        avatar     TEXT,
        expires_at INTEGER NOT NULL
    );
    `,
    /* v2: servidores de juego + filtros nuevos en campañas */ `
    CREATE TABLE game_servers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL CHECK (type IN ('minecraft','hytale')),
        host         TEXT NOT NULL,
        port         INTEGER,             -- puerto del juego (Minecraft: 25565 por defecto)
        api_port     INTEGER,             -- Minecraft: API de Spark (TPS/CPU) | Hytale: API Nitrado Query
        enabled      INTEGER NOT NULL DEFAULT 1,
        link_players INTEGER NOT NULL DEFAULT 1,  -- mencionar en Discord a los jugadores confirmados
        channel_id   TEXT,                -- mensaje de estado en Discord (opcional)
        message_id   TEXT,
        created_at   INTEGER NOT NULL
    );

    ALTER TABLE campaigns ADD COLUMN include_role_ids TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE campaigns ADD COLUMN input_long INTEGER NOT NULL DEFAULT 0;
    `,
    /* v3: roles por reacción */ `
    CREATE TABLE reaction_panels (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        exclusive    INTEGER NOT NULL DEFAULT 0,   -- solo un rol de este mensaje a la vez
        channel_id   TEXT,
        message_id   TEXT,
        manage_embed INTEGER NOT NULL DEFAULT 1,   -- el bot escribe/edita el embed (0 = mensaje ajeno o antiguo)
        title        TEXT NOT NULL DEFAULT '',
        description  TEXT NOT NULL DEFAULT '',
        color        TEXT NOT NULL DEFAULT '#5865F2',
        show_list    INTEGER NOT NULL DEFAULT 1,   -- añadir al embed la lista emoji → rol
        legacy       INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_reaction_panels_message ON reaction_panels (message_id);

    CREATE TABLE reaction_roles (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id INTEGER NOT NULL REFERENCES reaction_panels (id) ON DELETE CASCADE,
        emoji    TEXT NOT NULL,                    -- unicode, <:nombre:id> o (antiguo) solo el nombre
        role_id  TEXT NOT NULL,
        behavior TEXT NOT NULL DEFAULT 'toggle' CHECK (behavior IN ('toggle','add','remove','reverse','click')),
        label    TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_reaction_roles_panel ON reaction_roles (panel_id, position);
    `,
    /* v4: moderación + historial de los servidores de juego */ `
    CREATE TABLE mod_cases (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT NOT NULL,
        user_tag       TEXT,
        action         TEXT NOT NULL CHECK (action IN ('warn','note','timeout','untimeout','kick','ban','unban')),
        reason         TEXT,
        duration_ms    INTEGER,
        moderator_id   TEXT,
        moderator_name TEXT,
        source         TEXT NOT NULL DEFAULT 'panel',   -- panel | discord (hecho a mano en Discord)
        dm_status      TEXT,                            -- sent | failed | null (no se avisó)
        created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_mod_cases_user ON mod_cases (user_id, id);

    CREATE TABLE server_samples (
        server_id   INTEGER NOT NULL REFERENCES game_servers (id) ON DELETE CASCADE,
        ts          INTEGER NOT NULL,
        online      INTEGER NOT NULL,
        players     INTEGER,
        max_players INTEGER,
        latency_ms  INTEGER,
        tps         REAL,
        mspt        REAL,
        cpu         REAL
    );
    CREATE INDEX idx_server_samples ON server_samples (server_id, ts);
    `,
    /* v5: tickets */ `
    CREATE TABLE ticket_panels (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        channel_id  TEXT,
        message_id  TEXT,
        title       TEXT NOT NULL DEFAULT '🎫 Tickets',
        description TEXT NOT NULL DEFAULT 'Pulsa un botón para abrir un ticket.',
        color       TEXT NOT NULL DEFAULT '#5865F2',
        created_at  INTEGER NOT NULL
    );

    -- Cada botón del panel es un tipo de ticket (soporte, reportes…), con su propia configuración.
    CREATE TABLE ticket_types (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id         INTEGER NOT NULL REFERENCES ticket_panels (id) ON DELETE CASCADE,
        label            TEXT NOT NULL,
        emoji            TEXT NOT NULL DEFAULT '',
        style            TEXT NOT NULL DEFAULT 'primary' CHECK (style IN ('primary','secondary','success','danger')),
        category_id      TEXT,                          -- categoría donde se crean los canales
        support_role_ids TEXT NOT NULL DEFAULT '[]',
        name_template    TEXT NOT NULL DEFAULT 'ticket-{number}',
        welcome          TEXT NOT NULL DEFAULT '',
        questions        TEXT NOT NULL DEFAULT '[]',    -- formulario al abrir (máx. 5)
        max_open         INTEGER NOT NULL DEFAULT 1,    -- tickets abiertos a la vez por usuario (0 = sin límite)
        position         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tickets (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        number          INTEGER NOT NULL,
        type_id         INTEGER REFERENCES ticket_types (id) ON DELETE SET NULL,
        type_label      TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        user_tag        TEXT,
        user_avatar     TEXT,
        channel_id      TEXT,
        status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        answers         TEXT NOT NULL DEFAULT '[]',
        claimed_by_id   TEXT,
        claimed_by_name TEXT,
        close_reason    TEXT,
        closed_by_id    TEXT,
        closed_by_name  TEXT,
        created_at      INTEGER NOT NULL,
        closed_at       INTEGER,
        last_message_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tickets_status ON tickets (status, last_message_at);
    CREATE INDEX idx_tickets_user ON tickets (user_id);
    CREATE INDEX idx_tickets_channel ON tickets (channel_id);

    CREATE TABLE ticket_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        discord_id    TEXT,
        author_id     TEXT,
        author_name   TEXT,
        author_avatar TEXT,
        kind          TEXT NOT NULL CHECK (kind IN ('user','staff','panel','system')),
        content       TEXT NOT NULL DEFAULT '',
        attachments   TEXT NOT NULL DEFAULT '[]',     -- [{ name, url }]
        created_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_ticket_messages ON ticket_messages (ticket_id, id);
    `,
];

export function openDb(file = path.join(DATA_DIR, 'bot.db')): DB {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const current = db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
        db.transaction(() => {
            db.exec(MIGRATIONS[v]);
            db.pragma(`user_version = ${v + 1}`);
        })();
    }
    return db;
}

export function getSetting(db: DB, key: string, fallback: string): string {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
    db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
}
