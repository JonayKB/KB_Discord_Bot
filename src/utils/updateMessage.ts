import config from 'dotenv';
config.config();
import { Client, EmbedBuilder } from 'discord.js';
const { GUILD_ID } = process.env;
import { loadConfig } from './configManager.ts';
let retryTimeout: NodeJS.Timeout | undefined = undefined;
export default async function updateConfirmationsMessage(client: Client) {
    if(retryTimeout) return;
    const config = loadConfig();
    if (!config.mensajeID || !config.canalID || !config.rolContadoID) {
        console.warn('⚠️ Missing configuration for confirmation message update.');
        return;
    };

    try {
        console.info('🔄 Updating confirmation message...');
        if (!GUILD_ID) {
            console.warn('⚠️ Missing GUILD_ID environment variable.');
            return;
        }
        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.members.fetch();
        const rol = guild.roles.cache.get(config.rolContadoID);
        if (!rol) {
            console.warn('⚠️ Role not found.');
            return;
        }
        const incluidos = rol ? rol.members.size : 0;
        let genteString = "";
        rol.members.forEach((element) => genteString += "\n" + (element.user.globalName ?? element.user.username));
        const canal = await guild.channels.fetch(config.canalID);
        if (!canal) {
            console.warn('⚠️ Channel not found.');
            return;
        }

        if (!('messages' in canal) || typeof canal.messages === 'undefined') {
            console.warn('⚠️ Channel is not a text-based channel.');
            return;
        }
        const mensaje = await canal.messages.fetch(config.mensajeID);
        const embed = new EmbedBuilder()
            .setTitle('📊 Cantidad de Personas QUE HAN CONFIRMADO:')
            .setDescription(`\n\n ** Confirmados:** ${genteString}`)
            .setColor(0x27f720)
            .setFooter({ text: 'Actualizado automáticamente para ' + incluidos + ' personas' })
            .setTimestamp();
        await mensaje.edit({ embeds: [embed] });
        console.info('✅ Confirmation message updated successfully.');
        retryTimeout = undefined;
    } catch (error: any) {
        if (error.data.opcode === 8) {
            if (retryTimeout) return;
            console.warn('⚠️ Rate limit exceeded. Retrying... ' + error.data.retry_after + ' seconds');
            retryTimeout = setTimeout(() => updateConfirmationsMessage(client), error.data.retry_after * 1000 || 1000);
            return;
        }

        console.error('❌ Error updating confirmation message:', error);
        return;

    }
    return;
}