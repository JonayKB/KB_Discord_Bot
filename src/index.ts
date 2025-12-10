import { ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";

import config from 'dotenv';
import loadCommands from './commands/index';
import loadEvents from './events/index';
import { loadConfig } from './utils/configManager';
import updateConfirmationMessage from './utils/updateConfirmationMessage';
import sendConfirmationModal from "./utils/sendConfirmateModal";
import cron from 'node-cron';
import updateInfoMessage from "./utils/updateInfoMessage";
import { Logger } from "./utils/Logger";
import compressLogs from "./utils/LogCompreser";
const { GUILD_ID = 'NO_GUILD_ID', TOKEN } = process.env;
config.config();

const logger = new Logger("Index");


const timezone = process.env.TIMEZONE ?? 'Europe/Madrid'; // optional, set e.g. 'Europe/Madrid'
const options = timezone ? { scheduled: true, timezone } : { scheduled: true };

async function preloadMessages(client: Client) {
    const config = loadConfig();
    if (!config.reactions || config.reactions.length === 0) return;
    for (const r of config.reactions) {
        const channel = await client.channels.fetch(r.canalID);
        if (!channel || !('messages' in channel)) continue;
        await channel.messages.fetch(r.mensajeID);
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
async function sendConfirmationModalToMembers() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            logger.error('❌ Guild not found');
            return;
        }
        const allMembers = guild.members.cache;
        if (!allMembers) {
            logger.error('❌ Cannot fetch guild members');
            return;
        }

        const membersToSend = allMembers.filter(member =>
            !member.user.bot &&
            !member.roles.cache.has(ROL_NOT_TO_SEND_ID) &&
            !member.roles.cache.has(ROL_IGNORE_ID)
        ).map(m => m.user);

        await sendConfirmationModal(membersToSend);
        logger.info('✅ Confirmation modal sent by cron job');
    } catch (err: any) {
        logger.error('❌ Error sending confirmation modal in cron job:', err);
    }
}
// Register commands
loadCommands(client);



// Register events
loadEvents(client);

client.login(TOKEN);

logger.info("✅ Bot is running...");

const ROL_NOT_TO_SEND_ID = "1371833331800346725";
const ROL_IGNORE_ID = "1448303235285909605";

// On client ready
client.once('clientReady', async () => {
    if (!client.user) return;

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    logger.info("👥 All guild members fetched");
    logger.info(`🤖 Logged in as ${client.user.tag}`);

    preloadMessages(client);
    updateConfirmationMessage(client);

    try {
        cron.schedule('0 18 */2 * *', sendConfirmationModalToMembers, options);
        logger.info('⏰ Confirmation modal cron scheduled: every 2 days at 18:00');
    } catch (err: any) {
        logger.error('❌ Failed to schedule confirmation modal cron:', err);
    }

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


    // Initial update of info message
    updateInfoMessage(client);


    // Update info message every 30 seconds
    setInterval(async () => {
        updateInfoMessage(client);
    }, 30 * 1000);

    // Compress logs every day at midnight
    try {
        cron.schedule('0 0 * * *', async () => {
            compressLogs();
        }, options);
        logger.info('⏰ Log compression cron scheduled: daily at midnight');
    } catch (err: any) {
        logger.error('❌ Error compressing logs:', err);
    }

});

