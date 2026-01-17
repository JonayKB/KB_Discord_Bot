import { Client, EmbedBuilder, GuildMember } from "discord.js";
import fetchMcServerData from "./mcServerData";
import { loadConfig } from "./configManager";
import { configDotenv } from "dotenv";
import { Logger } from "./Logger";
import fs from "node:fs";
import path from "node:path";
import fetchHytaleServerData from "./hytaleServerData";
import { ServerStats } from "../types/informationType";
import ServerType from "../types/serverType";
const { SERVER_TYPE } = process.env;

const logger = new Logger("UpdateInfoMessage");
configDotenv();
enum colorCode {
    GREEN = "🟩 ",
    YELLOW = "🟨 ",
    RED = "🟥 ",
    EMPTY = "⬛ "
}

function colorTPS(tps: number): string {
    if (tps >= 15) return colorCode.GREEN;
    else if (tps >= 10) return colorCode.YELLOW;
    else return colorCode.RED;
}
function createPlayersBar(playersOnline: number, maxPlayers: number): string {
    const percentage = playersOnline / maxPlayers;
    let colorFull;
    if (percentage <= 0.5) colorFull = colorCode.GREEN;
    else if (percentage < 1) colorFull = colorCode.YELLOW;
    else colorFull = colorCode.RED;

    const full = colorFull.repeat(playersOnline);
    const empty = colorCode.EMPTY.repeat(maxPlayers - playersOnline);

    return full + empty;
}

function getPlayersDiscordsMentions(playerList: { name: string }[], guild: any): { minecraft: string, mention: string | null }[] {
    const mentions: { minecraft: string, mention: string | null }[] = [];
    for (const player of playerList) {
        let discordName = player.name;
        try {
            const namesPath = path.join(process.cwd(), "data", "names.json");
            if (fs.existsSync(namesPath)) {
                const raw = fs.readFileSync(namesPath, "utf8");
                const namesMap: Record<string, string> = JSON.parse(raw);
                const match = Object.entries(namesMap).find(([, mcName]) => mcName === player.name);
                if (match) discordName = match[0];
            }
        } catch {
            discordName = player.name;
        }
        const member = guild.members.cache.find((m: GuildMember) => m.user.username === discordName);
        if (member) {
            mentions.push({ minecraft: player.name, mention: member.toString() });
        } else {
            mentions.push({ minecraft: player.name, mention: null });
        }
    }
    return mentions;
}

export default async function updateInfoMessage(client: Client) {
    const config = loadConfig();
    let data: ServerStats | null = null;

    switch (SERVER_TYPE) {
        case ServerType.Hytale:
            data = await fetchHytaleServerData();
            break;
        case ServerType.Minecraft:
            data = await fetchMcServerData();
            break;
        default:
            break;
    }

    if (!config.canalInfoID || !config.mensajeInfoID) return;

    let embed;
    if (!data) {
        embed = new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle("⚠️ Servidor Offline")
            .addFields(
                {
                    name: "⚡ TPS",
                    value:
                        `${colorCode.RED} 10s: ** OFFLINE**\n` +
                        `${colorCode.RED} 1m: ** OFFLINE**\n` +
                        `${colorCode.RED} 5m: ** OFFLINE**\n` +
                        `${colorCode.RED} 15m: ** OFFLINE**`,
                    inline: true
                },
                {
                    name: "🖥️ Rendimiento",
                    value:
                        `• MSPT: **OFFLINE**\n` +
                        `• CPU: **OFFLINE**`,
                    inline: true
                },
                {
                    name: `👥 Jugadores (0/0)`,
                    value: ""
                },
                {
                    name: "🧑‍🚀 Lista de jugadores",
                    value: "*No hay jugadores conectados*"
                }
            )
            .setFooter({ text: 'Actualizado cada 30 segundos' })
            .setTimestamp();
    }
    else {
        const barraJugadores = createPlayersBar(data.playersOnline, data.maxPlayers);
        const guild = client.guilds.cache.get(process.env.GUILD_ID!);
        embed = new EmbedBuilder()
            .setColor("#00AAFF")
            .setTitle("📊 Estado del Servidor")
            .addFields(
                {
                    name: "⚡ TPS",
                    value:
                        `${colorTPS(data.tps_10s)} 10s: **${data.tps_10s.toFixed(2)}**\n` +
                        `${colorTPS(data.tps_1m)} 1m: **${data.tps_1m.toFixed(2)}**\n` +
                        `${colorTPS(data.tps_5m)} 5m: **${data.tps_5m.toFixed(2)}**\n` +
                        `${colorTPS(data.tps_15m)} 15m: **${data.tps_15m.toFixed(2)}**`,
                    inline: true
                },
                {
                    name: "🖥️ Rendimiento",
                    value:
                        `• MSPT: **${data.mspt_1m.toFixed(2)}ms**\n` +
                        `• CPU: **${(data.cpu * 100).toFixed(0)}%**`,
                    inline: true
                },
                {
                    name: `👥 Jugadores (${data.playersOnline}/${data.maxPlayers})`,
                    value: barraJugadores
                },
                {
                    name: "🧑‍🚀 Lista de jugadores",
                    value: data.playerList.length > 0
                        ? getPlayersDiscordsMentions(data.playerList, guild).map(p => `${p.minecraft} (${p.mention || "???"})`).join("\n")
                        : "*No hay jugadores conectados*"
                }
            )
            .setFooter({ text: 'Actualizado cada 30 segundos' })
            .setTimestamp();
    }


    const channel = await client.channels.fetch(config.canalInfoID);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(config.mensajeInfoID);
    if (!message) return;

    await message.edit({ embeds: [embed] });

}