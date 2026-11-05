import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { env } from '../../core/config';
import { getServices } from '../../core/services';
import { PERIOD_LABEL, STAT_INFO, STAT_KEYS, fmtStat, rankLine, type Period, type StatKey } from '../../modules/servers/ranking';

const TOP = 10;

/** /ranking: top de una estadística y la posición de quien lo ejecuta (respuesta efímera). */
export default {
    data: new SlashCommandBuilder()
        .setName('ranking')
        .setDescription('Muestra el ranking de una estadística del servidor de Minecraft')
        .addStringOption(o => o.setName('estadistica').setDescription('Qué estadística').setRequired(true)
            .addChoices(...STAT_KEYS.map(k => ({ name: STAT_INFO[k].label, value: k }))))
        .addStringOption(o => o.setName('periodo').setDescription('Total o esta semana').setRequired(true)
            .addChoices({ name: 'Total', value: 'total' }, { name: 'Esta semana', value: 'weekly' }))
        .addIntegerOption(o => o.setName('servidor').setDescription('ID del servidor (lo ves en el panel). Por defecto, el primero con estadísticas').setMinValue(1)),

    async execute(interaction: ChatInputCommandInteraction) {
        const { servers, mcStats } = getServices();
        const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
        if (!mcStats.active) return void await reply('❌ Las estadísticas están desactivadas ahora mismo.');

        const key = interaction.options.getString('estadistica', true) as StatKey;
        const period = interaction.options.getString('periodo', true) as Period;
        const wanted = interaction.options.getInteger('servidor');
        const candidates = servers.list().filter(s => s.type === 'minecraft');
        const server = wanted
            ? candidates.find(s => s.id === wanted)
            : candidates.find(s => mcStats.serverInfo(s.id)?.lastPushAt) ?? candidates[0];
        if (!server) return void await reply(wanted ? `❌ No hay ningún servidor de Minecraft con ID ${wanted}.` : '❌ Aún no hay servidores de Minecraft configurados.');

        const rows = mcStats.ranking(server.id, key, period);
        const guild = interaction.client.guilds.cache.get(env.guildId);
        const inGuild = (id: string) => !!guild?.members.cache.has(id);
        const info = mcStats.serverInfo(server.id);
        const lines = rows.slice(0, TOP).map((r, i) => rankLine(i + 1, r, key, inGuild));

        const mine = rows.findIndex(r => r.discordId === interaction.user.id);
        const you = mine >= 0
            ? `Tu posición: **#${mine + 1}** de ${rows.length} · ${fmtStat(key, rows[mine].value)}`
            : 'No apareces en este ranking (¿has entrado al servidor con tu cuenta de Discord vinculada?).';

        const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle(`${STAT_INFO[key].emoji} ${STAT_INFO[key].label} · ${PERIOD_LABEL[period]}`)
            .setDescription(`${lines.join('\n') || '*Sin datos todavía*'}\n\n${you}`.slice(0, 4096))
            .setFooter({ text: info?.displayName ?? server.name });
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};
