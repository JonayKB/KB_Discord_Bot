import { Client, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from "discord.js";
import { Logger } from "../../utils/Logger";

const logger = new Logger("ReplyModal");

export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: any) {
        if (interaction.isButton()) {
            if (interaction.customId.startsWith("reply_")) {
                const userId = interaction.customId.split("_")[1];
                const modal = new ModalBuilder()
                    .setCustomId(`reply_modal_${userId}`)
                    .setTitle(`Responder a ${userId}`)
                    .addComponents(
                        new ActionRowBuilder<TextInputBuilder>().addComponents(
                            new TextInputBuilder()
                                .setCustomId("response_input")
                                .setLabel("Tu respuesta")
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                        )
                    );

                await interaction.showModal(modal);
            }
        } else if (interaction.isModalSubmit()) {
            if (!interaction.customId.startsWith("reply_modal_")) return;
            const userId = interaction.customId.split("_")[2];
            const response = interaction.fields.getTextInputValue("response_input");

            try {
                const user = await client.users.fetch(userId);
                if (!user) return;

                await user.send(`📩 Respuesta del Administrador: ${response}`);
                await interaction.reply({ content: "✅ Mensaje enviado al usuario", ephemeral: true });
            } catch (err) {
                logger.error(err);
                await interaction.reply({ content: "❌ No se pudo enviar el mensaje", ephemeral: true });
            }
        }
    }
};
