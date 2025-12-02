import type { Client, User } from 'discord.js';
import { loadConfig } from '../../utils/configManager.ts';
import updateConfirmationMessage from '../../utils/updateMessage.ts';
import type { ReactionData } from '../../types/reactionData.ts';

export default {
    name: "messageReactionRemove",
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
        if (rol && member.roles.cache.has(rol.id)) {
            await member.roles.remove(rol);
            console.info(`➖ Rol ${rol.name} removed from ${user.tag} successfully.`);
            await updateConfirmationMessage(client);
        }
    }
}