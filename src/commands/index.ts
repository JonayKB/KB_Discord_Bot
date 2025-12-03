import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';

export default async (client: Client) => {
    const commandsPath = path.join(__dirname); // carpeta commands
    const folders = fs.readdirSync(commandsPath).filter(f =>
        fs.statSync(path.join(commandsPath, f)).isDirectory()
    );

    const ext = process.env.NODE_ENV === 'production' ? '.js' : '.ts';

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
                        console.error(error);
                        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                    }
                }
            });

            console.info(`🗹 Loaded command: ${command.data.name}`);
        }
    }

    // Registrar comandos con REST
    const { CLIENT_ID, GUILD_ID, TOKEN } = process.env;
    if (!CLIENT_ID || !GUILD_ID || !TOKEN) return console.error('❌ Missing environment variables');

    const { REST, Routes } = await import('discord.js');
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.info('🔁 Adding slash commands...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.info('✅ Slash commands added successfully.');
    } catch (error) {
        console.error('❌ Error adding slash commands:', error);
    }
};
