import { type Client, type GuildMember } from "discord.js";
import { Logger } from '../../utils/Logger';
import { getServices } from '../../core/services';

const logger = new Logger("GuildMemberAdd");


export default {
    name: "guildMemberAdd",

    async execute(_client: Client, member: GuildMember) {
        logger.info(`➡️ New member: ${member.user.tag}`);

        // El formulario de confirmación lo envía ahora el módulo "Confirmaciones"
        // (campañas con la opción "enviar al unirse"). Aquí solo queda la bienvenida.
        try {
            await getServices().messages.sendToUser(member.id, {
                embed: {
                    author: "🐉 MCKBSERVERS",
                    title: "✨ ¡Bienvenido!",
                    description:
                        `Hey **{username}**, nos alegra verte por aquí 💚  

> Este es mi servidor de Discord, donde encontrarás **los mejores servidores de juegos** que soy capaz de crear.  
> ¡Espero que disfrutes tu estancia y te unas a la aventura! 🚀`,
                    color: "#00FF00",
                    thumbnail: "{avatar}",
                    footer: "Sistema automático de bienvenida",
                    timestamp: true,
                },
            }, { source: 'welcome' });
        } catch (err: any) {
            logger.warn(`⚠️ No se pudo enviar el mensaje de bienvenida a ${member.user.tag}: ${err?.message ?? err}`);
        }
    }
};
