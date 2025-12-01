module.exports = function parseEmoji(guild, raw) {

    // Si es :emoji:
    if (raw.startsWith(":") && raw.endsWith(":")) {
        const name = raw.slice(1, -1);
        const emoji = guild.emojis.cache.find(e => e.name === name);

        if (!emoji) throw new Error(`Emoji ${raw} no existe en el servidor.`);

        return {
            react: emoji.toString(),         // <:emoji:id>
            compare: emoji.name              // para comparar reactions.emoji.name
        };
    }

    // Si es un unicode normal
    return {
        react: raw,
        compare: raw
    };
}
