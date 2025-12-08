import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { saveConfig, loadConfig } from '../../utils/configManager';
import updateConfirmationMessage from '../../utils/updateConfirmationMessage';

export default {
    data: new SlashCommandBuilder()
        .setName('create_confirmation_message')
        .setDescription('Crea un mensaje de confirmación para nuevos miembros o cambia el mensaje al que apunta')
        .addChannelOption(option =>
            option.setName('canal').setDescription('Canal donde enviar el mensaje').setRequired(true))
        .addRoleOption(option =>
            option.setName('rol_contado').setDescription('Rol que se contará en el mensaje de confirmación').setRequired(true)),

    async execute(interaction: any) {
        console.log(typeof interaction);
        const canal = interaction.options.getChannel('canal');
        const rolContado = interaction.options.getRole('rol_contado');
        const config = loadConfig();
        const embed = new EmbedBuilder()
            .setTitle('📊 Creado Mensaje de confirmación')
            .setDescription(`\n\n ** ESPERANDO ACTUALIZACIÓN...**`)
            .setColor(0x0000FF)
            .setFooter({ text: 'Actualizado automáticamente para el rol ' + rolContado.name })
            .setTimestamp();
        const mensaje = await canal.send({ embeds: [embed] });
        config.mensajeID = mensaje.id;
        config.canalID = canal.id;
        config.rolContadoID = rolContado.id;

        saveConfig(config);


        await updateConfirmationMessage(interaction.client);

        interaction.reply({ content: '✅ Message Ready.', ephemeral: true });
    }
};
