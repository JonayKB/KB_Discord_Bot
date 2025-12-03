import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    type Interaction,
    Client
} from "discord.js";

export default {
    name: "interactionCreate",
    async execute(client: Client, interaction: Interaction) {
        if (!interaction.isButton()) return;
        if (interaction.customId !== "open_confirmation_modal") return;

        const modal = new ModalBuilder()
            .setCustomId("confirmation_modal")
            .setTitle("Formulario de confirmación");

        const input = new TextInputBuilder()
            .setCustomId("confirmation_input")
            .setLabel("Escribe tu nombre de usuario en Minecraft")
            .setStyle(TextInputStyle.Short);

        const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);

        modal.addComponents(row);

        await interaction.showModal(modal);
    }
}