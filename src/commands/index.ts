import { Client, REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';
import config from 'dotenv';
import { fileURLToPath } from 'url';


// Cargar variables de entorno
config.config();
const { CLIENT_ID, GUILD_ID, TOKEN } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (client: Client) => {
    const commandsPath = path.join(__dirname);
    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        if (folder === 'index.ts') continue;

        const folderPath = path.join(commandsPath, folder);
        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.ts'));

        const commands = [];

        for (const file of commandFiles) {
            const command = await import(path.join(folderPath, file));



            commands.push(command.default.data.toJSON());

            client.on("interactionCreate", async interaction => {
                if (!interaction.isChatInputCommand()) return;

                if (interaction.commandName === command.default.data.name) {
                    try {
                        await command.default.execute(interaction, client);
                    } catch (error) {
                        console.error(error);
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            });


            console.info(`🗹 Loaded command: ${command.default.data.name}`);
        }

        // Crear instancia REST
        if (TOKEN === undefined || CLIENT_ID === undefined || GUILD_ID === undefined) {
            console.error('❌ Missing environment variables for Discord bot.');
            return;
        }
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
