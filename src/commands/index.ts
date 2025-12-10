import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'discord.js';
import { Logger } from '../utils/Logger';

const logger = new Logger("CommandLoader");

export default async function loadCommands(client: Client) {
    const commandsPath = path.join(__dirname);
    const folders = fs.readdirSync(commandsPath).filter(f =>
        fs.statSync(path.join(commandsPath, f)).isDirectory()
    );


    const commands: any[] = [];

    for (const folder of folders) {
        const folderPath = path.join(commandsPath, folder);
        const files = fs.readdirSync(folderPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

        for (const file of files) {
            const { default: command } = await import(path.join(folderPath, file));
            commands.push(command.data.toJSON());

            client.on("interactionCreate", async interaction => {
                if (!interaction.isChatInputCommand()) return;

                if (interaction.commandName === command.data.name) {
                    try {
                        await command.execute(interaction, client);
                    } catch (error) {
                        logger.error(error);
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            });

            logger.info(`🗹 Loaded command: ${command.data.name}`);
        }
    }

    // Register commands with Discord API
    const { CLIENT_ID, GUILD_ID, TOKEN } = process.env;
    if (!CLIENT_ID || !GUILD_ID || !TOKEN) return logger.error('❌ Missing environment variables');

    const { REST, Routes } = await import('discord.js');
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        logger.info('🔁 Adding slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        logger.info('✅ Slash commands added successfully.');
    } catch (error: any) {
        logger.error('❌ Error adding slash commands:', error);
    }
}
