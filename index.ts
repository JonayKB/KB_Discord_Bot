import { Client } from "discord.js";

import config from 'dotenv';
import { GatewayIntentBits, Partials, Collection } from 'discord.js';
import loadCommands from './src/commands/index.ts';
import loadEvents from './src/events/index.ts';
import { loadConfig } from './src/utils/configManager.ts';
import updateConfirmationMessage from './src/utils/updateMessage.ts';

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

// Registrar comandos

client.commands = new Collection();
loadCommands(client);



// Registrar eventos
loadEvents(client);

client.login(process.env.TOKEN);

console.info("✅ Bot is running");

client.once('clientReady', async () => {
    if (!client.user) return;
    console.info(`🤖 Logged in as ${client.user.tag}`);
    preloadMessages(client);
    updateConfirmationMessage(client);
});
