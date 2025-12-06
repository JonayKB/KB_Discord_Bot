import { EmbedBuilder, type Client, type GuildMember } from "discord.js";
import updateConfirmationsMessage from '../../utils/updateMessage';
import sendConfirmationModal from "../../utils/sendConfirmateModal";


export default {
    name: "guildMemberAdd",

    async execute(client: Client, member: GuildMember) {
        console.info(`➡️ New member: ${member.user.tag}`);
        await updateConfirmationsMessage(client);
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setAuthor({
                name: "🐉 MCKBSERVERS",
            })
            .setTitle("✨ ¡Bienvenido!")
            .setDescription(
                `Hey **${member.user.username}**, nos alegra verte por aquí 💚  

> Este es mi servidor de Discord, donde encontrarás **los mejores servidores de juegos** que soy capaz de crear.  
> ¡Espero que disfrutes tu estancia y te unas a la aventura! 🚀`
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 1024 }))
            .setFooter({
                text: "Sistema automático de bienvenida",
            })
            .setTimestamp();


        await member.send({ embeds: [embed] }).catch(() => {
            console.warn(`⚠️ No se pudo enviar el mensaje de bienvenida a ${member.user.tag}.`);
        });
        await sendConfirmationModal([member]);
    }
};
