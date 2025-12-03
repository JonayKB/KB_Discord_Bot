import type { GuildMember, User } from "discord.js";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from "discord.js";

export default async function sendConfirmationModal(users: User[]|GuildMember[]) {
    console.info(`📩 Sending confirmation modal to users`);

    const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("open_confirmation_modal")
            .setLabel("Abrir formulario de confirmación")
            .setStyle(ButtonStyle.Primary)
    );

    for (const user of users) {
        try {
            await user.send({
                content: "Haz clic en el botón para abrir el formulario de confirmación (requerirás tu nombre de usuario de Minecraft):",
                components: [button]
            });
        } catch (e) {
            console.error(`❌ No se pudo enviar DM a ${user.displayName}`, e);
        }
    }
}
