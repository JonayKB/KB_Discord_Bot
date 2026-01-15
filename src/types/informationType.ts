export interface ServerStats {
    tps_10s: number;
    tps_1m: number;
    tps_5m: number;
    tps_15m: number;
    mspt_1m: number;
    cpu: number;
    playersOnline: number;
    maxPlayers: number;
    playerList: PlayerInfo[];
}

export interface PlayerInfo {
    name: string;
    id: string;
}
