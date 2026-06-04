const { MINECRAFT_SERVER_IP, MINECRAFT_SERVER_PORT, MINECRAFT_API_PORT } = process.env;
import { statusLegacy, queryFull } from 'minecraft-server-util';
import { ServerStats, PlayerInfo } from '../types/informationType';
import { Logger } from './Logger';

interface SparkRestResponse {
    tps_10s: number;
    tps_1m: number;
    tps_5m: number;
    tps_15m: number;
    mspt_1m: number;
    cpu: number;
}

const logger = new Logger("FetchMcServerData");

export default function fetchMcServerData() {
    const data = fetch(`http://${MINECRAFT_SERVER_IP}:${MINECRAFT_API_PORT}/metrics`)
        .then(response => {
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        })
        .then(async (data: SparkRestResponse) => {
            const ip = MINECRAFT_SERVER_IP ?? 'localhost';
            const port = MINECRAFT_SERVER_PORT ? Number(MINECRAFT_SERVER_PORT) : 25565;

            const [statusRes, queryRes] = await Promise.all([
                statusLegacy(ip, port, { timeout: 5000 }),
                queryFull(ip, port, { timeout: 5000 })
            ]);

            const playerList: PlayerInfo[] = (queryRes.players.list ?? []).map(name => ({
                name,
                id: ''
            }));

            return {
                tps_10s: data.tps_10s,
                tps_1m: data.tps_1m,
                tps_5m: data.tps_5m,
                tps_15m: data.tps_15m,
                mspt_1m: data.mspt_1m,
                cpu: data.cpu,
                playersOnline: statusRes.players.online,
                maxPlayers: statusRes.players.max,
                playerList
            } as ServerStats;
        })
        .catch(error => {
            logger.error('Error fetching metrics:', error);
            return null;
        });

    return data;
}