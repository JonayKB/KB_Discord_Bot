import config from 'dotenv';
config.config();
import { Client, EmbedBuilder } from 'discord.js';
const { GUILD_ID } = process.env;
import { loadConfig } from './configManager';
import { Logger } from './Logger';
let retryTimeout: NodeJS.Timeout | undefined = undefined;
const logger = new Logger("UpdateConfirmationMessage");
export default async function updateConfirmationsMessage(client: Client, retry = false) {
    if ((retry && !retryTimeout) || (!retry && retryTimeout)) return;
    const cfg = loadConfig();
    if (!cfg.mensajeID || !cfg.canalID || !cfg.rolContadoID) {
        logger.warn('⚠️ Missing configuration for confirmation message update.');
        return;
    }

    try {
        logger.info('🔄 Updating confirmation message...');
        if (!GUILD_ID) {
            logger.warn('⚠️ Missing GUILD_ID environment variable.');
            return;
        }

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            logger.warn('⚠️ Guild not found.');
            return;
        }

        const rol = guild.roles.cache.get(cfg.rolContadoID);
        if (!rol) {
            logger.warn('⚠️ Role not found.');
            return;
        }

        const incluidos = rol.members.size;
        const genteString = Array.from(rol.members.values())
            .map((m) => m.user.globalName ?? m.user.username)
            .join('\n');

        const canal = await guild.channels.fetch(cfg.canalID);
        if (!canal || !('messages' in canal) || canal.messages === undefined) {
            logger.warn('⚠️ Channel not found or is not a text-based channel.');
            return;
        }

        let mensaje = canal.messages.cache.get(cfg.mensajeID) ?? await canal.messages.fetch(cfg.mensajeID);
        const embed = buildConfirmationEmbed(genteString, incluidos, guild.memberCount);
        await mensaje.edit({ embeds: [embed] });
        logger.info('✅ Confirmation message updated successfully.');
        retryTimeout = undefined;
    } catch (error: any) {
        handleUpdateError(error, client);
    }
}

function buildConfirmationEmbed(genteString: string, incluidos: number, memberCount: number) {
    return new EmbedBuilder()
        .setTitle('📊 Cantidad de Personas QUE HAN CONFIRMADO:')
        .setDescription(`\n\n ** Confirmados:** ${genteString}\n\n ** Total de personas que han confirmado:** ${incluidos}`)
        .setColor(0x27f720)
        .setFooter({ text: 'Actualizado automáticamente para ' + memberCount + ' personas' })
        .setTimestamp();
}

function handleUpdateError(error: any, client: Client) {
    const opcode = error?.data?.opcode;
    const retryAfter = error?.data?.retry_after;
    if (opcode === 8) {
        if (retryTimeout) return;
        logger.warn('⚠️ Rate limit exceeded. Retrying... ' + retryAfter + ' seconds');
        retryTimeout = setTimeout(() => updateConfirmationsMessage(client, true), (retryAfter ?? 1) * 1000);
        return;
    }
    logger.error('❌ Error updating confirmation message:', error);
}