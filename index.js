require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const loadCommands = require('./src/commands');
const loadEvents = require('./src/events');
const { loadConfig } = require('./src/utils/configManager');
const updateConfirmationMessage = require('./src/utils/updateMessage');


async function preloadMessages(client) {
    const config = loadConfig();
    for (const r of config.reactions) {
        const channel = await client.channels.fetch(r.canalID);
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
    console.info(`🤖 Logged in as ${client.user.tag}`);
    preloadMessages(client);
    updateConfirmationMessage(client);
});
