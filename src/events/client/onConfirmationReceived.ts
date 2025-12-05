import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    type Interaction,
    Client
} from "discord.js";
import path from "path";
import { promises as fs } from "fs";
import { loadConfig } from "../../utils/configManager";
import envConfig   from 'dotenv';
import updateConfirmationMessage from './utils/updateMessage';

envConfig.config();

const namesPath = path.join(process.cwd(), 'data', 'names.json');


export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: Interaction) {
        if (!interaction.isModalSubmit()) return;
        if (interaction.customId !== "confirmation_modal") return;

        const response = interaction.fields.getTextInputValue("confirmation_input");


        console.log(`📝 Response of ${interaction.user.tag}: ${response}`);
        try {
            let data: Record<string, string> = {};
            try {
                const raw = await fs.readFile(namesPath, "utf8");
                data = JSON.parse(raw) as Record<string, string>;
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                    console.error("Error reading names.json:", err);
                }
            }

            data[interaction.user.username] = response;

            await fs.writeFile(namesPath, JSON.stringify(data, null, 2), "utf8");
        } catch (err) {
            console.error("Error saving confirmation:", err);
        }

        // Add role to the member in the guild (User doesn't have addRole)
        try {
            const config = loadConfig();
            const roleId = config.ROL_CONTADO_ID || config.rolContadoID || "";
            if (!roleId) {
                console.warn("No role ID provided in environment (ROL_CONTADO_ID or rolContadoID)");
            } else {
                const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
                const member = await guild.members.fetch(interaction.user.id);
                await member.roles.add(roleId);
                console.info(`➕ Added role to ${interaction.user.tag}`);
                const globalName = interaction.user.globalName ?? interaction.user.username;
                console.info(`🆔 Global name for ${interaction.user.tag} is "${globalName}"`);
                try {

                    const minecraftUsername = response.length > 32 ? response.slice(0, 32) : response;
                    console.log(`${globalName} (${minecraftUsername})`);
                    await member.setNickname(`${globalName} (${minecraftUsername})`);
                    console.info(`✏️ Set nickname for ${interaction.user.tag} to "${minecraftUsername}"`);
                    updateConfirmationMessage(client);
                } catch (err) {
                    console.warn("Couldn't set nickname (missing permissions or hierarchy):", err);
                }
            }
        } catch (err) {
            console.error("Error adding role:", err);
        }

        await interaction.reply({
            content: "¡Recibido! Gracias por tu respuesta.",
            ephemeral: true
        });
    }
}
