import { EmbedBuilder, type Client, type GuildMember } from "discord.js";
import updateConfirmationsMessage from '../../utils/updateMessage';

export default {
    name: "guildMemberRemove",

    async execute(client: Client, member: GuildMember) {
        console.info(`➡️ Member left: ${member.user.tag}`);

        // Actualizar tu mensaje global
        await updateConfirmationsMessage(client);

        // Embed estilizado
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setAuthor({ name: "🐉 MCKBSERVERS" })
            .setTitle("✨ ¡Adiós!")
            .setDescription(
                `Hey **${member.user.username}**, nos entristece verte partir 💔

> Este servidor siempre tendrá las puertas abiertas para ti.  
> ¡Esperamos que vuelvas pronto! 🚀`
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 1024 }))
            .setFooter({ text: "Sistema automático de despedida" })
            .setTimestamp();

        // Enviar DM
        await member.user.send({ embeds: [embed] }).catch(() => {
            console.warn(`⚠️ No se pudo enviar el mensaje de despedida a ${member.user.tag}.`);
        });
    }
};
