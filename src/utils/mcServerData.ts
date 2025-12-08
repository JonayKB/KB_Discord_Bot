const { MINECRAFT_SERVER_IP, MINECRAFT_SERVER_PORT, MINECRAFT_API_PORT } = process.env;

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
        .then((data: SparkRestResponse) => {
            return {
                tps_10s: data.tps_10s,
                tps_1m: data.tps_1m,
                tps_5m: data.tps_5m,
                tps_15m: data.tps_15m,
                mspt_1m: data.mspt_1m,
                cpu: data.cpu,
                playersOnline: 0,
                maxPlayers: 0,
                playerList: []
            };

        })
        .catch(error => {
            console.warn('Error fetching Minecraft server data');
            return null;
        });

    return data;
}
