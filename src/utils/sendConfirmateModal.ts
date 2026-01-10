import type { GuildMember, User } from "discord.js";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from "discord.js";
import { Logger } from "./Logger";

const logger = new Logger("SendConfirmationModal");

export default async function sendConfirmationModal(users: User[] | GuildMember[]) {
    logger.info(`📩 Sending confirmation modal to users`);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("open_confirmation_modal")
            .setLabel("Abrir formulario")
            .setEmoji("📝")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("open_denied_confirmation_modal")
            .setLabel("No deseo participar")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger)
    );


    for (const user of users) {
        try {
            const embed = new EmbedBuilder()
                .setColor('#3B82F6')
                .setTitle('✨ Confirmación de Participación')
                .setDescription(
                    `Para unirte al servidor de HYTALE, completa el formulario usando el botón de abajo.

                    **Requisito:** Usuario de HYTALE.`
                )
                .setTimestamp()
                .setFooter({ text: 'Sistema automático de confirmación' });


            await user.send({
                embeds: [embed],
                components: [buttons]
            });
            logger.info(`📩 Message sent to ${user.displayName}`);
        } catch (e: any) {
            logger.error(`❌ No se pudo enviar DM a ${user.displayName}`, e);
        }
    }
}
