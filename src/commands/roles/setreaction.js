const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { saveConfig, loadConfig } = require('../../utils/configManager');
const parseEmoji = require('../../utils/emojiParser');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setreaction')
        .setDescription('Configura un mensaje con reacción para asignar roles')
        .addChannelOption(option =>
            option.setName('canal').setDescription('Canal donde enviar el mensaje').setRequired(true))
        .addStringOption(option =>
            option.setName('titulo').setDescription('Título del embed').setRequired(true))
        .addStringOption(option =>
            option.setName('descripcion').setDescription('Descripción').setRequired(true))
        .addStringOption(option =>
            option.setName('color').setDescription('Color HEX').setRequired(true))
        .addStringOption(option =>
            option.setName('emoji').setDescription('Emoji :nombre: o emoji real').setRequired(true))
        .addRoleOption(option =>
            option.setName('rol').setDescription('Rol a asignar').setRequired(true)),

    async execute(interaction) {
        const canal = interaction.options.getChannel('canal');
        const titulo = interaction.options.getString('titulo');
        const descripcion = interaction.options.getString('descripcion');
        const color = interaction.options.getString('color') || '#ffffff';
        let emojiInput = interaction.options.getString('emoji');
        const rol = interaction.options.getRole('rol');

        // convertir :emoji:
        const parsedEmoji = parseEmoji(interaction.guild, emojiInput);

        const embed = new EmbedBuilder()
            .setTitle(titulo)
            .setDescription(descripcion)
            .setColor(color);

        const mensaje = await canal.send({ embeds: [embed] });
        await mensaje.react(parsedEmoji.react);

        const config = loadConfig();
        config.reactions.push({
            canalID: canal.id,
            mensajeID: mensaje.id,
            rolID: rol.id,
            emoji: parsedEmoji.compare
        });
        saveConfig(config);
        console.info(`✅ Reaction role set: Message ID ${mensaje.id}, Role ${rol.name}, Emoji ${parsedEmoji.compare}`);

        interaction.reply({ content: '✅ Mensaje configurado.', ephemeral: true });
    }
};
