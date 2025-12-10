const { MINECRAFT_SERVER_IP, MINECRAFT_SERVER_PORT, MINECRAFT_API_PORT } = process.env;
import { status } from 'minecraft-server-util';

interface SparkRestResponse {
    tps_10s: number;
    tps_1m: number;
    tps_5m: number;
    tps_15m: number;
    mspt_1m: number;
    cpu: number;
}


export default function fetchMcServerData() {

    const data = fetch(`http://${MINECRAFT_SERVER_IP}:${MINECRAFT_API_PORT}/metrics`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(async (data: SparkRestResponse) => {
            const port = MINECRAFT_SERVER_PORT ? Number(MINECRAFT_SERVER_PORT) : 25565;
            const response = await status(MINECRAFT_SERVER_IP ?? 'localhost', port, { timeout: 5000 }).then((status) => {
                return {
                    tps_10s: data.tps_10s,
                    tps_1m: data.tps_1m,
                    tps_5m: data.tps_5m,
                    tps_15m: data.tps_15m,
                    mspt_1m: data.mspt_1m,
                    cpu: data.cpu,
                    playersOnline: status.players.online,
                    maxPlayers: status.players.max,
                    playerList: status.players.sample ?? []
                };
            }).catch(() => {
                return null;
            });

            return response;

        })
        .catch(error => {
            return null;
        });

    return data;
}
