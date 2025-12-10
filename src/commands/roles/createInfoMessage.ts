import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { saveConfig, loadConfig } from '../../utils/configManager';
import updateInfoMessage from '../../utils/updateInfoMessage';
import { Logger } from '../../utils/Logger';

const logger = new Logger("CreateInfoMessageCommand");



export default {
    data: new SlashCommandBuilder()
        .setName('create_info_message')
        .setDescription('Crea un mensaje de información para nuevos miembros o cambia el mensaje al que apunta')
        .addChannelOption(option =>
            option.setName('canal').setDescription('Canal donde enviar el mensaje').setRequired(true)),

    async execute(interaction: any) {


        const canal = interaction.options.getChannel('canal');
        const config = loadConfig();
        const embed = new EmbedBuilder()
            .setTitle('ℹ️ Información del Servidor')
            .setDescription('Este mensaje proporciona información importante para los nuevos miembros.')
            .setColor('#0099ff');
        
        const mensaje = await canal.send({ embeds: [embed] });
        config.mensajeInfoID = mensaje.id;
        config.canalInfoID = canal.id;

        saveConfig(config);

        logger.info(`✅ Info message created`);

        updateInfoMessage(interaction.client);

        interaction.reply({ content: '✅ Message Ready.', ephemeral: true });
    }
};
