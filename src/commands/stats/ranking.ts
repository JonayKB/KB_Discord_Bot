import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getServices } from '../../core/services';
import { STAT_INFO, STAT_KEYS, type Period, type StatKey } from '../../modules/servers/ranking';

/**
 * /ranking: top 10 de una estadística y la posición de quien lo ejecuta (respuesta privada).
 * Lleva el mismo menú de categorías y botones de periodo que los rankings publicados en un canal.
 */
export default {
    data: new SlashCommandBuilder()
        .setName('ranking')
        .setDescription('Muestra el ranking del servidor de Minecraft')
        .addStringOption(o => o.setName('estadistica').setDescription('Qué estadística (por defecto, tiempo jugado)')
            .addChoices(...STAT_KEYS.map(k => ({ name: STAT_INFO[k].label, value: k }))))
        .addStringOption(o => o.setName('periodo').setDescription('Total o esta semana (por defecto, total)')
            .addChoices({ name: 'Total', value: 'total' }, { name: 'Esta semana', value: 'weekly' }))
        .addIntegerOption(o => o.setName('servidor').setDescription('ID del servidor (lo ves en el panel). Por defecto, el primero con estadísticas').setMinValue(1)),

    async execute(interaction: ChatInputCommandInteraction) {
        const { servers, mcStats } = getServices();
        const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
        if (!mcStats.active) return void await reply('❌ Las estadísticas están desactivadas ahora mismo.');

        const stat = (interaction.options.getString('estadistica') ?? 'playTimeSeconds') as StatKey;
        const period = (interaction.options.getString('periodo') ?? 'total') as Period;
        const wanted = interaction.options.getInteger('servidor');
        const candidates = servers.list().filter(s => s.type === 'minecraft');
        const server = wanted
            ? candidates.find(s => s.id === wanted)
            : candidates.find(s => mcStats.serverInfo(s.id)?.lastPushAt) ?? candidates[0];
        if (!server) return void await reply(wanted ? `❌ No hay ningún servidor de Minecraft con ID ${wanted}.` : '❌ Aún no hay servidores de Minecraft configurados.');

        const message = mcStats.renderServer(server.id, { stat, period, viewerId: interaction.user.id })!;
        await interaction.reply({ ...message, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
    },
};
