import { type Client, type GuildMember } from "discord.js";
import updateConfirmationsMessage from '../../utils/updateConfirmationMessage';
import { Logger } from '../../utils/Logger';

const logger = new Logger("GuildMemberRemove");

export default {
    name: "guildMemberRemove",

    async execute(client: Client, member: GuildMember) {
        logger.info(`➡️ Member left: ${member.user.tag}`);

        await updateConfirmationsMessage(client);
    }
};
