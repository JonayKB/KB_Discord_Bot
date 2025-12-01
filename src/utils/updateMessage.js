require('dotenv').config();
const { EmbedBuilder } = require('discord.js');
const { GUILD_ID } = process.env;
const { loadConfig } = require('./configManager');

module.exports = async function updateConfirmationsMessage(client) {
    const config = loadConfig();
    if (!config.mensajeID || !config.canalID || !config.rolContadoID) {
        console.warn('⚠️ Missing configuration for confirmation message update.');
        return;
    };

    try {
        console.info('🔄 Updating confirmation message...');
        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.members.fetch();
        const rol = guild.roles.cache.get(config.rolContadoID);
        const incluidos = rol ? rol.members.size : 0;
        let genteString = "";
        rol.members.forEach((element) => genteString += "\n" + (element.user.globalName ?? element.user.username));
        const canal = await guild.channels.fetch(config.canalID);
        const mensaje = await canal.messages.fetch(config.mensajeID);
        const embed = new EmbedBuilder()
            .setTitle('📊 Cantidad de Personas QUE HAN CONFIRMADO:')
            .setDescription(`\n\n ** Confirmados:** ${genteString}`)
            .setColor(0x27f720)
            .setFooter({ text: 'Actualizado automáticamente para ' + incluidos + ' personas' })
            .setTimestamp();
        await mensaje.edit({ embeds: [embed] });
    } catch (error) {
        if (error.data.opcode === 8) {
            console.warn('⚠️ Rate limit exceeded. Retrying...');
            setTimeout(() => updateConfirmationsMessage(client), error.data.retry_after*1000 || 1000);
            return;
        }

        console.error('❌ Error updating confirmation message:', error);
        return;

    }
    return;
}