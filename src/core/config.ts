import dotenv from 'dotenv';

dotenv.config();

const list = (v: string | undefined): string[] =>
    (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

const port = Number(process.env.PANEL_PORT ?? 3000);

/**
 * Configuración central leída de variables de entorno (.env).
 * Todo lo que antes estaba "hardcodeado" y se puede cambiar en caliente
 * vive ahora en la base de datos y se gestiona desde el panel.
 */
export const env = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    isProduction: process.env.NODE_ENV === 'production',
    token: process.env.TOKEN ?? '',
    clientId: process.env.CLIENT_ID ?? '',
    guildId: process.env.GUILD_ID ?? '',
    timezone: process.env.TIMEZONE ?? 'Europe/Madrid',
    adminId: process.env.ADMIN_ID ?? '335537584686235649',

    panel: {
        enabled: process.env.PANEL_ENABLED !== 'false',
        host: process.env.PANEL_HOST ?? '127.0.0.1',
        port,
        /** URL pública con la que accedes al panel (se usa para el redirect de OAuth2). */
        url: (process.env.PANEL_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
        clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
        /** IDs de usuario con acceso. Por defecto, solo ADMIN_ID. */
        adminIds: list(process.env.PANEL_ADMIN_IDS ?? process.env.ADMIN_ID ?? '335537584686235649'),
        /** (Opcional) cualquier miembro del servidor con alguno de estos roles también entra. */
        roleIds: list(process.env.PANEL_ROLE_IDS),
        sessionHours: Number(process.env.PANEL_SESSION_HOURS ?? 24 * 7),
        /** Solo funciona si NODE_ENV != production. Para probar el panel sin Discord. */
        devAuth: process.env.PANEL_DEV_AUTH === '1' && process.env.NODE_ENV !== 'production',
    },

    maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 10),
};
