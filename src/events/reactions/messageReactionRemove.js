const { loadConfig } = require('../../utils/configManager');
const updateConfirmationMessage = require('../../utils/updateMessage');


module.exports = {
    name: "messageReactionRemove",
    async execute(client, reaction, user) {
        console.info(`🔔 Processing reaction removal by ${user.tag} on message ${reaction.message.id}`);
        const config = loadConfig();
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
        if (config.reactions.length === 0) return;
        const reactionConfig = config.reactions.find(r => r.mensajeID === reaction.message.id && r.emoji === reaction.emoji.name);
        if (!reactionConfig) return;
        const member = await reaction.message.guild.members.fetch(user.id);
        const rol = reaction.message.guild.roles.cache.get(reactionConfig.rolID);
        console.info(`🔔 Reaction removed by ${user.tag} on message ${reaction.message.id} for role ${rol ? rol.name : 'unknown'}`);
        if (rol && member.roles.cache.has(rol.id)) {
            await member.roles.remove(rol);
            console.info(`➖ Rol ${rol.name} removed from ${user.tag} successfully.`);
            await updateConfirmationMessage(client);
        }
    }
}