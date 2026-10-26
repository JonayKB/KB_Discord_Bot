import { type Client, type GuildMember } from "discord.js";
import { Logger } from '../../utils/Logger';

const logger = new Logger("GuildMemberRemove");

export default {
    name: "guildMemberRemove",

    async execute(_client: Client, member: GuildMember) {
        // El contador de confirmados se refresca solo desde el módulo "Confirmaciones".
        logger.info(`➡️ Member left: ${member.user.tag}`);
    }
};
