import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getServices } from '../../core/services';
import { Logger } from '../../utils/Logger';

const logger = new Logger("CreateInfoMessageCommand");

/**
 * Publica el mensaje de estado de un servidor de juego en un canal.
 * Lo mismo se puede hacer (y configurar) desde la sección "Servidores" del panel.
 */
export default {
    data: new SlashCommandBuilder()
        .setName('create_info_message')
        .setDescription('Publica (o mueve) el mensaje con el estado de un servidor de juego')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption(option =>
            option.setName('canal').setDescription('Canal donde enviar el mensaje').setRequired(true))
        .addIntegerOption(option =>
            option.setName('servidor').setDescription('ID del servidor (lo ves en el panel). Por defecto, el primero').setMinValue(1)),

    async execute(interaction: ChatInputCommandInteraction) {
        const { servers } = getServices();
        const canal = interaction.options.getChannel('canal', true);
        const wanted = interaction.options.getInteger('servidor');
        const server = wanted ? servers.get(wanted) : servers.list()[0];

        if (!server) {
            await interaction.reply({
                content: wanted ? `❌ No existe ningún servidor con ID ${wanted}.` : '❌ Aún no hay servidores configurados. Añádelos en la sección "Servidores" del panel.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        try {
            await servers.createMessage(server.id, canal.id);
            logger.info(`✅ Mensaje de estado de "${server.name}" creado en el canal ${canal.id}`);
            await interaction.reply({ content: `✅ Mensaje de estado de **${server.name}** listo.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
            await interaction.reply({ content: `❌ ${(err as Error).message}`, flags: MessageFlags.Ephemeral });
        }
    }
};
