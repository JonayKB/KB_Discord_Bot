import type { Client, GuildMember } from "discord.js";
import updateConfirmationsMessage from '../../utils/updateMessage';


export default {
    name: "guildMemberAdd",

    async execute(client: Client, member: GuildMember) {
        console.info(`➡️ New member: ${member.user.tag}`);
        await updateConfirmationsMessage(client);
    }
};
