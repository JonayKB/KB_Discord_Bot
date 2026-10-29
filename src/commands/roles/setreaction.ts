import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getServices } from '../../core/services';
import type { Behavior } from '../../modules/reactions/service';
import { Logger } from '../../utils/Logger';

const logger = new Logger("SetReactionCommand");

/**
 * Atajo para crear un mensaje de roles por reacción con un solo rol.
 * Para varios roles, editarlo o cambiar el comportamiento, usa la sección "Roles por reacción" del panel.
 */
export default {
    data: new SlashCommandBuilder()
        .setName('setreaction')
        .setDescription('Configura un mensaje con reacción para asignar roles')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
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
            option.setName('rol').setDescription('Rol a asignar').setRequired(true))
        .addStringOption(option =>
            option.setName('modo').setDescription('Qué pasa al reaccionar (por defecto: normal)').addChoices(
                { name: 'Normal: reaccionar da el rol, quitar la reacción lo quita', value: 'toggle' },
                { name: 'Permanente: reaccionar da el rol y ya no se pierde', value: 'add' },
                { name: 'Quitar: reaccionar te quita el rol', value: 'remove' },
                { name: 'Invertido: reaccionar lo quita, quitar la reacción lo devuelve', value: 'reverse' },
                { name: 'Pulsar: cada reacción lo da o lo quita (se borra la reacción)', value: 'click' },
            )),

    async execute(interaction: ChatInputCommandInteraction) {
        const { reactions } = getServices();
        const canal = interaction.options.getChannel('canal', true);
        const titulo = interaction.options.getString('titulo', true);
        const rol = interaction.options.getRole('rol', true);
        let color = interaction.options.getString('color', true).trim();
        if (!color.startsWith('#')) color = `#${color}`;
        if (!/^#[0-9a-f]{6}$/i.test(color)) color = '#5865F2';

        try {
            const { panel, warnings } = await reactions.create({
                name: titulo.slice(0, 80),
                enabled: true,
                exclusive: false,
                title: titulo,
                description: interaction.options.getString('descripcion', true),
                color,
                showList: false,
                entries: [{
                    emoji: interaction.options.getString('emoji', true),
                    roleId: rol.id,
                    behavior: (interaction.options.getString('modo') ?? 'toggle') as Behavior,
                    label: '',
                }],
            }, { type: 'new', channelId: canal.id });
            logger.info(`✅ Reaction role set: Message ID ${panel.messageId}, Role ${rol.name}, Emoji ${panel.entries[0].emoji}`);
            await interaction.reply({
                content: `✅ Message ready.${warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''}`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            await interaction.reply({ content: `❌ ${(err as Error).message}`, flags: MessageFlags.Ephemeral });
        }
    }
};
