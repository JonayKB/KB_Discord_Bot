import { env } from "./core/config";
import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";
import { Cron } from "croner";

import loadCommands from './commands/index';
import loadEvents from './events/index';
import { loadConfig } from './utils/configManager';
import { Logger } from "./utils/Logger";
import compressLogs from "./utils/LogCompreser";

import { openDb } from "./core/db";
import { startLogCapture } from "./core/logs";
import { ModuleManager } from "./core/module";
import { setServices } from "./core/services";
import { migrateLegacy, migrateServers } from "./core/migrateLegacy";
import { startWebServer } from "./web/server";

import { MessagesService, createMessagesModule } from "./modules/messages";
import { InboxService, createInboxModule } from "./modules/inbox";
import { ConfirmationService } from "./modules/confirmations/service";
import { createConfirmationsModule } from "./modules/confirmations";
import { SchedulerService } from "./modules/scheduler/service";
import { createSchedulerModule } from "./modules/scheduler";
import { ServersService, createServersModule } from "./modules/servers";

startLogCapture();
const logger = new Logger("Index");

// Un error inesperado en una promesa no debe tumbar el bot entero.
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', reason));
process.on('uncaughtException', (err) => logger.error('Uncaught exception', err));

async function preloadMessages(client: Client) {
    const config = loadConfig();
    if (!config.reactions || config.reactions.length === 0) return;
    for (const r of config.reactions) {
        try {
            const channel = await client.channels.fetch(r.canalID);
            if (!channel || !('messages' in channel)) continue;
            await channel.messages.fetch(r.mensajeID);
        } catch (err) {
            logger.error(`No se pudo precargar el mensaje de reacciones ${r.mensajeID}`, err);
        }
    }
    logger.info("✅ All reaction messages preloaded");
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const activities = [
    { name: "🛠️ Configurando el servidor", type: ActivityType.Competing },
    { name: "🐉 MCKBServers en construcción", type: ActivityType.Playing },
    { name: "💬 Hablando con la comunidad", type: ActivityType.Watching },
    { name: "⚒️ Creando nuevas funciones", type: ActivityType.Playing },
    { name: "🌐 Preparando eventos", type: ActivityType.Competing },
    { name: "🚀 Mejorando la experiencia", type: ActivityType.Playing },
    { name: "📢 Anunciando novedades", type: ActivityType.Watching },
    { name: "🎉 Celebrando con los miembros", type: ActivityType.Playing },
    { name: "🤖 Automatizando tareas", type: ActivityType.Competing },
    { name: "🔧 Mantenimiento del servidor", type: ActivityType.Playing },
    { name: "📊 Analizando datos", type: ActivityType.Watching }
];

// ───────────── Base de datos, servicios y módulos ─────────────
const db = openDb();
const manager = new ModuleManager(client, db);

const messages = new MessagesService(client, db);
const confirmations = new ConfirmationService(client, db, messages);
const inbox = new InboxService(db, messages);
const scheduler = new SchedulerService(db, messages, confirmations);
const servers = new ServersService(client, db, confirmations);
setServices({ messages, confirmations, servers });

manager.register(createMessagesModule(messages, db));
manager.register(createInboxModule(inbox, messages, db));
manager.register(createSchedulerModule(scheduler));
manager.register(createConfirmationsModule(confirmations));
manager.register(createServersModule(servers));

// ───────────── Código "clásico" (info del servidor, roles por reacción, bienvenida) ─────────────
loadCommands(client);
loadEvents(client);

// ───────────── Panel web ─────────────
const server = env.panel.enabled ? startWebServer({ client, db, manager }) : null;

if (!env.token) logger.error('❌ Falta TOKEN en el .env: el bot no puede conectarse a Discord.');
client.login(env.token).catch(err => logger.error('❌ No se pudo iniciar sesión en Discord', err));
logger.info("✅ Bot is starting...");

const cronOptions = { timezone: env.timezone };

// On client ready
client.once('clientReady', async () => {
    if (!client.user) return;

    const guild = await client.guilds.fetch(env.guildId);
    await guild.members.fetch();
    logger.info("👥 All guild members fetched");
    logger.info(`🤖 Logged in as ${client.user.tag}`);

    // Migra una sola vez la configuración antigua a la base de datos y arranca los módulos activos.
    try {
        migrateLegacy(db);
        migrateServers(db);
    } catch (err) {
        logger.error('❌ Falló la migración de datos antiguos', err);
    }
    await manager.startEnabled();

    preloadMessages(client);

    // Set random activity status every X minutes
    const timeInterval = 5;

    client.user?.setPresence({
        status: "online",
        activities: [activities[0]]
    });

    setInterval(() => {
        const activity = activities[Math.floor(Math.random() * activities.length)];
        client.user?.setPresence({
            status: "online",
            activities: [activity]
        });
    }, timeInterval * 60 * 1000);

    // El mensaje de estado de los servidores de juego lo mantiene ahora el módulo "Servidores de juego".

    // Compress logs every day at midnight
    try {
        new Cron('0 0 * * *', cronOptions, () => {
            try { compressLogs(); } catch (err) { logger.error('❌ Error compressing logs:', err); }
        });
        logger.info('⏰ Log compression cron scheduled: daily at midnight');
    } catch (err: any) {
        logger.error('❌ Failed to schedule log compression:', err);
    }
});

// ───────────── Apagado limpio (pm2 reload / Ctrl+C) ─────────────
let closing = false;
async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    logger.info(`🛑 ${signal} recibido, cerrando…`);
    scheduler.stop();
    servers.stop();
    server?.close();
    await client.destroy();
    db.close();
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
