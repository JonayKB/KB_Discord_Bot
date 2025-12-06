import type { GuildMember, User } from "discord.js";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from "discord.js";

export default async function sendConfirmationModal(users: User[] | GuildMember[]) {
    console.info(`📩 Sending confirmation modal to users`);

    const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
    .setCustomId("open_confirmation_modal")
    .setLabel("Abrir formulario")
    .setEmoji("📝")
    .setStyle(ButtonStyle.Secondary)

    );

    for (const user of users) {
        try {
            const embed = new EmbedBuilder()
                .setColor('#3B82F6')
                .setTitle('✨ Confirmación de Participación')
                .setDescription(
                    `Para unirte al servidor de Minecraft, completa el formulario usando el botón de abajo.  
        
                    **Requisito:** Usuario de Minecraft.`
                )
                .setTimestamp()
                .setFooter({ text: 'Sistema automático de confirmación' });


            await user.send({
                embeds: [embed],
                components: [button]
            });
            console.log(`📩 Message sent to ${user.displayName}`);
        } catch (e) {
            console.error(`❌ No se pudo enviar DM a ${user.displayName}`, e);
        }
    }
}
