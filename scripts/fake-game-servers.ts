/**
 * Servidores de juego falsos para pruebas (sin Minecraft real):
 *  - un servidor TCP que responde al "ping" de estado de Minecraft (Server List Ping)
 *  - un servidor HTTP que imita la API de métricas de Spark (/metrics)
 */
import http from 'node:http';
import net from 'node:net';

function varInt(n: number): Buffer {
    const out: number[] = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return Buffer.from(out);
}

function readVarInt(buf: Buffer, off: number): [value: number, size: number] | null {
    let v = 0;
    for (let i = 0; i < 5; i++) {
        if (off + i >= buf.length) return null;
        const b = buf[off + i];
        v |= (b & 0x7f) << (7 * i);
        if (!(b & 0x80)) return [v, i + 1];
    }
    throw new Error('VarInt demasiado largo');
}

function packet(id: number, payload: Buffer): Buffer {
    const body = Buffer.concat([varInt(id), payload]);
    return Buffer.concat([varInt(body.length), body]);
}

export interface FakeMcState {
    online: number;
    max: number;
    players: string[];
    version: string;
    motd: string;
}

export function startFakeMinecraft(port: number, state: FakeMcState): net.Server {
    return net.createServer(sock => {
        let buf = Buffer.alloc(0);
        sock.on('error', () => undefined);
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
                const len = readVarInt(buf, 0);
                if (!len || buf.length < len[1] + len[0]) return;
                const body = buf.subarray(len[1], len[1] + len[0]);
                buf = buf.subarray(len[1] + len[0]);
                const id = readVarInt(body, 0)!;
                if (id[0] === 0 && body.length === id[1]) {
                    // Status Request → respuesta JSON
                    const json = JSON.stringify({
                        version: { name: state.version, protocol: 767 },
                        players: { online: state.online, max: state.max, sample: state.players.slice(0, 12).map((name, i) => ({ name, id: `00000000-0000-0000-0000-00000000000${i}` })) },
                        description: { text: state.motd },
                    });
                    const s = Buffer.from(json, 'utf8');
                    sock.write(packet(0, Buffer.concat([varInt(s.length), s])));
                } else if (id[0] === 1) {
                    // Ping → Pong con el mismo payload
                    sock.write(packet(1, body.subarray(id[1])));
                }
                // id 0 con datos = Handshake: no hace falta responder
            }
        });
    }).listen(port, '127.0.0.1');
}

export function startFakeSpark(port: number, tps = 19.84): http.Server {
    return http.createServer((req, res) => {
        if (req.url !== '/metrics') { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ tps_10s: tps, tps_1m: tps, tps_5m: 19.97, tps_15m: 19.99, mspt_1m: 12.4, cpu: 0.37 }));
    }).listen(port, '127.0.0.1');
}
