import { type Client, type GuildMember } from "discord.js";
import updateConfirmationsMessage from '../../utils/updateMessage';

export default {
    name: "guildMemberRemove",

    async execute(client: Client, member: GuildMember) {
        console.info(`➡️ Member left: ${member.user.tag}`);

        await updateConfirmationsMessage(client);
    }
};
