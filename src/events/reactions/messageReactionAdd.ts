import type { Client, User } from "discord.js";
import type { ReactionData } from "../../types/reactionData";

import { loadConfig } from '../../utils/configManager';
import updateConfirmationMessage from '../../utils/updateConfirmationMessage';
import { Logger } from '../../utils/Logger';

const logger = new Logger("MessageReactionAdd");
export default {
    name: "messageReactionAdd",
    async execute(client: Client, reaction: any, user: User) {
        const config = loadConfig();
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
        if (!config.reactions || config.reactions.length === 0) return;

        const reactionConfig = config.reactions.find((r: ReactionData) => r.mensajeID === reaction.message.id && r.emoji === reaction.emoji.name);
        if (!reactionConfig) return;
        const member = await reaction.message.guild.members.fetch(user.id);
        const rol = reaction.message.guild.roles.cache.get(reactionConfig.rolID);
        if (rol && !member.roles.cache.has(rol.id)) {
            await member.roles.add(rol);
            logger.info(`➕ Rol ${rol.name} assigned to ${user.tag} successfully.`);
            await updateConfirmationMessage(client);
        }
    }
}