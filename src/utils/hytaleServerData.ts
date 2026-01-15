import { PlayerInfo, ServerStats } from "../types/informationType";

const { HYTALE_SERVER_IP, HYTALE_API_PORT } = process.env;

interface HytaleServerData {
  Server: Server;
  Players: Player[];
}

interface Player {
  Name: string;
  UUID: string;
  World: string;
}

interface Server {
  Name: string;
  Version: string;
  Revision: string;
  Patchline: string;
  ProtocolVersion: number;
  ProtocolHash: string;
  MaxPlayers: number;
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export default async function fetchHytaleServerData(): Promise<ServerStats | null> {
  try {
    const response = await fetch(`https://${HYTALE_SERVER_IP}:${HYTALE_API_PORT}/Nitrado/Query`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data: HytaleServerData = await response.json();
    return {
        "cpu": 0,
        "playersOnline": data.Players.length,
        "maxPlayers": data.Server.MaxPlayers,
        "playerList": data.Players.map(player => ({
            name: player.Name,
            id: player.UUID
        } as PlayerInfo)),
        "mspt_1m": 1,
        "tps_10s": 20,
        "tps_1m": 20,
        "tps_5m": 20,
        "tps_15m": 20,

    } as ServerStats;
  } catch (error) {
    console.error('Error fetching Hytale server data:', error);
    return null;
  }
}
