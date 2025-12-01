const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
require('dotenv').config();

// Cargar variables de entorno
const { CLIENT_ID, GUILD_ID, TOKEN } = process.env;

module.exports = (client) => {
    const commandsPath = path.join(__dirname);
    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        if (folder === 'index.js') continue;

        const folderPath = path.join(commandsPath, folder);
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

        const commands = [];

        for (const file of commandFiles) {
            const command = require(path.join(folderPath, file));


            commands.push(command.data.toJSON());

            client.on("interactionCreate", async interaction => {
                if (!interaction.isChatInputCommand()) return;

                if (interaction.commandName === command.data.name) {
                    try {
                        await command.execute(interaction, client);
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            });


            console.info(`🗹 Loaded command: ${command.data.name}`);
        }

        // Crear instancia REST
        const rest = new REST({ version: '10' }).setToken(TOKEN);

        (async () => {
            try {
                console.info('🔁 Adding slash commands...');
                await rest.put(
                    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
                    { body: commands },
                );
                console.info('✅ Slash commands added successfully.');
            } catch (error) {
                console.error('❌ Error adding slash commands:', error);
            }
        })();
    }
};
