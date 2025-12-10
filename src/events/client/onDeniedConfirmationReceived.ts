import {
    type Interaction,
    Client
} from "discord.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import envConfig from 'dotenv';
import { Logger } from "../../utils/Logger";

const logger = new Logger("DeniedConfirmationReceived");


envConfig.config();

const deniedPath = path.join(process.cwd(), 'data', 'denied_reasons.json');


export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: Interaction) {
        if (!interaction.isModalSubmit()) return;
        if (interaction.customId !== "denied_confirmation_modal") return;

        const response = interaction.fields.getTextInputValue("denied_confirmation_input");


        logger.info(`📝 Response of denial from ${interaction.user.tag}: ${response}`);
        try {
            let data: Record<string, string> = {};
            try {
                const raw = await fs.readFile(deniedPath, "utf8");
                data = JSON.parse(raw) as Record<string, string>;
            } catch (err: any) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                    logger.error("Error reading names.json:", err);
                }
            }

            data[interaction.user.username] = response;

            await fs.writeFile(deniedPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err: any) {
            logger.error("Error saving denied reasons:", err);
        }

        // Add role to the member in the guild (User doesn't have addRole)
        try {
            const roleId = "1448303235285909605"
            const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.add(roleId);
            logger.info(`➕ Added role ${roleId} to ${interaction.user.tag}`);
        } catch (err: any) {
            logger.error("Error adding role:", err);
        }

        await interaction.reply({
            content: "¡Recibido! Espero verte en otra ocasión. 😊",
            ephemeral: true
        });
    }
}
