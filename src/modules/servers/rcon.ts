import net from 'node:net';

/**
 * Cliente RCON mínimo (protocolo Source RCON que usa Minecraft).
 * Paquete: [longitud int32 LE][id int32 LE][tipo int32 LE][texto ASCII][0x00 0x00]
 */

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;

export class RconError extends Error {}

function encode(id: number, type: number, body: string): Buffer {
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + payload.length);
    buf.writeInt32LE(10 + payload.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    return buf; // los dos últimos bytes ya son 0
}

/**
 * Abre una conexión, se autentica, ejecuta los comandos en orden y la cierra.
 * Devuelve la respuesta de cada comando.
 */
export async function rconRun(host: string, port: number, password: string, commands: string[], timeoutMs = 6000): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        let buffer = Buffer.alloc(0);
        let nextId = 1;
        const waiting = new Map<number, (body: string) => void>();
        let done = false;

        const finish = (err: Error | null, result?: string[]) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            if (err) reject(err); else resolve(result!);
        };
        const timer = setTimeout(() => finish(new RconError('El servidor no respondió a tiempo por RCON.')), timeoutMs);

        const send = (type: number, body: string) => new Promise<string>((res, rej) => {
            const id = nextId++;
            waiting.set(id, res);
            socket.write(encode(id, type, body), err => { if (err) rej(err); });
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4) {
                const len = buffer.readInt32LE(0);
                if (buffer.length < 4 + len) break;
                const id = buffer.readInt32LE(4);
                const body = buffer.toString('utf8', 12, 4 + len - 2);
                buffer = buffer.subarray(4 + len);
                if (id === -1) return finish(new RconError('Contraseña de RCON incorrecta.'));
                waiting.get(id)?.(body);
                waiting.delete(id);
            }
        });
        socket.on('error', err => {
            const code = (err as NodeJS.ErrnoException).code;
            finish(new RconError(code === 'ECONNREFUSED' ? 'Conexión RCON rechazada (¿enable-rcon=true y el puerto es correcto?).' : `Error de conexión RCON: ${err.message}`));
        });
        socket.on('close', () => finish(new RconError('El servidor cerró la conexión RCON.')));

        socket.once('connect', async () => {
            try {
                await send(TYPE_AUTH, password);
                const out: string[] = [];
                for (const c of commands) out.push(await send(TYPE_COMMAND, c));
                finish(null, out);
            } catch (err) {
                finish(err as Error);
            }
        });
    });
}

/** Quita los códigos de color de Minecraft (§a, §l…) de una respuesta. */
export const stripColors = (s: string) => s.replace(/§[0-9a-fk-or]/gi, '');
