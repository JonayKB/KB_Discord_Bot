import {
    type Interaction,
    Client
} from "discord.js";
import path from "path";
import { promises as fs } from "fs";
import { loadConfig } from "../../utils/configManager";
import envConfig   from 'dotenv';
import updateConfirmationMessage from '../../utils/updateConfirmationMessage';

envConfig.config();

const deniedPath = path.join(process.cwd(), 'data', 'denied_reasons.json');


export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: Interaction) {
        if (!interaction.isModalSubmit()) return;
        if (interaction.customId !== "denied_confirmation_modal") return;

        const response = interaction.fields.getTextInputValue("denied_confirmation_input");


        console.info(`📝 Response of denial from ${interaction.user.tag}: ${response}`);
        try {
            let data: Record<string, string> = {};
            try {
                const raw = await fs.readFile(deniedPath, "utf8");
                data = JSON.parse(raw) as Record<string, string>;
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                    console.error("Error reading names.json:", err);
                }
            }

            data[interaction.user.username] = response;

            await fs.writeFile(deniedPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err) {
            console.error("Error saving denied reasons:", err);
        }

        // Add role to the member in the guild (User doesn't have addRole)
        try {
            const config = loadConfig();
            const roleId = "1448303235285909605"
            if (!roleId) {
                console.warn("No role ID provided to add on denial.");
            } else {
                const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
                const member = await guild.members.fetch(interaction.user.id);
                await member.roles.add(roleId);
                console.info(`➕ Added role ${roleId} to ${interaction.user.tag}`);
            }
        } catch (err) {
            console.error("Error adding role:", err);
        }

        await interaction.reply({
            content: "¡Recibido! Espero verte en otra ocasión. 😊",
            ephemeral: true
        });
    }
}
