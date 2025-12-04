import { Client } from "discord.js";

import config from 'dotenv';
import { GatewayIntentBits, Partials, Collection } from 'discord.js';
import loadCommands from './commands/index';
import loadEvents from './events/index';
import { loadConfig } from './utils/configManager';
import updateConfirmationMessage from './utils/updateMessage';
import sendConfirmationModal from "./utils/sendConfirmateModal";
import cron from 'node-cron';
import { set } from "pm2";

config.config();

async function preloadMessages(client: Client) {
    const config = loadConfig();
    if (!config.reactions || config.reactions.length === 0) return;
    for (const r of config.reactions) {
        const channel = await client.channels.fetch(r.canalID);
        if (!channel || !('messages' in channel)) continue;
        await channel.messages.fetch(r.mensajeID);
    }
    console.info("✅ All reaction messages preloaded");
}
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});
async function sendConfirmationModalToMembers() {
    try {
        const allMembers = await client.guilds.cache.first()?.members.fetch();
        if (!allMembers) {
            console.warn('⚠️ No members found in the guild.');
            return;
        }
        const membersToSend = allMembers.filter(member =>
            !member.user.bot &&
            !member.roles.cache.has(ROL_NOT_TO_SEND_ID)
        ).map(member => member.user);

        console.log(`📊 Members to send confirmation modal: ${membersToSend.length}`);
        await sendConfirmationModal(membersToSend);
        console.info('✅ Confirmation modal sent by cron job');
    } catch (err: any) {
        if (err.data.opcode === 8) {
            setTimeout(sendConfirmationModalToMembers, err.data.retry_after * 1000);
            return;
        }
        console.error('❌ Error sending confirmation modal in cron job:', err);
    }
}
// Registrar comandos
loadCommands(client);



// Registrar eventos
loadEvents(client);

client.login(process.env.TOKEN);

console.info("✅ Bot is running...");

const ADMIN_ID = "335537584686235649";
const ROL_NOT_TO_SEND_ID = "1371833331800346725";

client.once('clientReady', async () => {
    if (!client.user) return;
    console.info(`🤖 Logged in as ${client.user.tag}`);
    preloadMessages(client);
    updateConfirmationMessage(client);
    try {
        const timezone = process.env.TIMEZONE ?? 'Europe/Madrid'; // optional, set e.g. 'Europe/Madrid'
        const options = timezone ? { scheduled: true, timezone } : { scheduled: true };
        cron.schedule('0 18 */3 * *', sendConfirmationModalToMembers, options);

        console.info('⏰ Confirmation modal cron scheduled: every 3 days at 18:00');
    } catch (err) {
        console.error('❌ Failed to schedule confirmation modal cron:', err);
    }

});

