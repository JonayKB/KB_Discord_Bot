import https from "node:https";
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

// El servidor de Hytale usa un certificado autofirmado. Antes se desactivaba la verificación TLS
// de TODO el proceso (NODE_TLS_REJECT_UNAUTHORIZED=0), lo que también afectaría al login con Discord
// del panel. Ahora solo se relaja para esta petición concreta.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getJsonInsecure<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: insecureAgent, timeout: 5000 }, res => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP error! status: ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

export default async function fetchHytaleServerData(): Promise<ServerStats | null> {
  try {
    const data = await getJsonInsecure<HytaleServerData>(`https://${HYTALE_SERVER_IP}:${HYTALE_API_PORT}/Nitrado/Query`);
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
