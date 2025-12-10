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
    async execute(client: Client, interaction: any) {
        if (!interaction.isButton()) return;
        if (interaction.customId !== "open_denied_confirmation_modal") return;

        const modal = new ModalBuilder()
            .setCustomId("denied_confirmation_modal")
            .setTitle("Confirmación de No Participación");

        const input = new TextInputBuilder()
            .setCustomId("denied_confirmation_input")
            .setLabel("Indica el motivo de tu no participación")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);

        modal.addComponents(row);
        

        await interaction.showModal(modal);
    }
}