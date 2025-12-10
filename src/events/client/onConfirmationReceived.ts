import {
    type Interaction,
    Client
} from "discord.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "../../utils/configManager";
import envConfig from 'dotenv';
import updateConfirmationMessage from '../../utils/updateConfirmationMessage';
import { Logger } from "../../utils/Logger";

const logger = new Logger("ConfirmationReceived");

envConfig.config();

const namesPath = path.join(process.cwd(), 'data', 'names.json');


export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: Interaction) {
        if (!interaction.isModalSubmit()) return;
        if (interaction.customId !== "confirmation_modal") return;

        const response = interaction.fields.getTextInputValue("confirmation_input");


        logger.info(`📝 Response of confirmation from ${interaction.user.tag}: ${response}`);
        try {
            let data: Record<string, string> = {};
            try {
                const raw = await fs.readFile(namesPath, "utf8");
                data = JSON.parse(raw) as Record<string, string>;
            } catch (err: any) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                    logger.error("Error reading names.json:", err);
                }
            }

            data[interaction.user.username] = response;

            await fs.writeFile(namesPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err: any) {
            logger.error("Error saving confirmation:", err);
        }

        // Add role to the member in the guild (User doesn't have addRole)
        try {
            const config = loadConfig();
            const roleId = config.ROL_CONTADO_ID || config.rolContadoID || "";

            const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.add(roleId);
            logger.info(`➕ Added role to ${interaction.user.tag}`);
            const globalName = interaction.user.globalName ?? interaction.user.username;
            logger.info(`🆔 Global name for ${interaction.user.tag} is "${globalName}"`);
            try {

                const minecraftUsername = response.length > 32 ? response.slice(0, 32) : response;
                logger.info(`${globalName} (${minecraftUsername})`);
                await member.setNickname(`${globalName} (${minecraftUsername})`);
                logger.info(`✏️ Set nickname for ${interaction.user.tag} to "${minecraftUsername}"`);
                updateConfirmationMessage(client);
            } catch (err: any) {
                logger.error("Couldn't set nickname (missing permissions or hierarchy):", err);
            }

        } catch (err: any) {
            logger.error("Error adding role:", err);
        }

        await interaction.reply({
            content: "¡Recibido! Gracias por tu respuesta.",
            ephemeral: true
        });
    }
}
