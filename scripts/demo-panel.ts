/**
 * Arranca el panel con un Discord SIMULADO y datos de ejemplo, para ver y probar la interfaz sin conectarte a Discord.
 *
 *   npm run demo        →  http://localhost:3100  (entra con "modo desarrollo")
 *
 * No toca tu base de datos real: usa una carpeta temporal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbot-demo-'));
fs.mkdirSync(path.join(tmp, 'data'));
const people: Array<[string, string]> = [
    ['100', 'steve'], ['101', 'alex_gamer'], ['102', 'creeper99'], ['103', 'luna'], ['104', 'pixel'], ['105', 'zoe_mc'], ['106', 'nico'], ['107', 'marta'],
];
fs.writeFileSync(path.join(tmp, 'data', 'names.json'), JSON.stringify({ steve: 'Steve_MC', alex_gamer: 'AlexG', luna: 'LunaCraft', zoe_mc: 'ZoeMC', ghost_user: 'Ghost' }));
fs.writeFileSync(path.join(tmp, 'data', 'denied_reasons.json'), JSON.stringify({ nico: 'Ahora no tengo tiempo' }));
fs.writeFileSync(path.join(tmp, 'data', 'config.json'), JSON.stringify({ rolContadoID: 'R_OK', canalID: 'C_COUNT', mensajeID: 'M1' }));
process.chdir(tmp);

const PORT = Number(process.env.DEMO_PORT ?? 3100);
Object.assign(process.env, {
    TOKEN: 'demo', CLIENT_ID: '1', GUILD_ID: 'G1', ADMIN_ID: 'ADMIN', PANEL_PORT: String(PORT), PANEL_URL: `http://localhost:${PORT}`,
    PANEL_DEV_AUTH: '1', NODE_ENV: 'development', PANEL_HOST: '127.0.0.1',
});

const src = (p: string) => path.resolve(__dirname, '..', 'src', p);

function png(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 3 + 1)] = 0;
        for (let x = 0; x < w; x++) raw.set(rgb(x, y), y * (w * 3 + 1) + 1 + x * 3);
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
    const { createMockDiscord } = await import('./mock-discord');
    const { openDb, UPLOADS_DIR } = await import(src('core/db'));
    const { ModuleManager } = await import(src('core/module'));
    const { MessagesService, createMessagesModule } = await import(src('modules/messages'));
    const { InboxService, createInboxModule } = await import(src('modules/inbox'));
    const { ConfirmationService } = await import(src('modules/confirmations/service'));
    const { createConfirmationsModule } = await import(src('modules/confirmations'));
    const { SchedulerService } = await import(src('modules/scheduler/service'));
    const { createSchedulerModule } = await import(src('modules/scheduler'));
    const { ServersService, createServersModule } = await import(src('modules/servers'));
    const { startFakeMinecraft, startFakeSpark } = await import('./fake-game-servers');
    const { startWebServer } = await import(src('web/server'));
    const { migrateLegacy } = await import(src('core/migrateLegacy'));
    const { setServices } = await import(src('core/services'));
    const { registerFile } = await import(src('core/files'));
    const { startLogCapture } = await import(src('core/logs'));
    startLogCapture();

    const mock = createMockDiscord('G1');
    for (const [id, name] of people) mock.addMember(id, name);
    mock.addMember('999', 'okuser', ['R_OK']);
    mock.mkUser('ADMIN', 'admin');
    const ok = mock.addRole('R_OK', 'Confirmado MC', '#3ba55d');
    for (const id of ['100', '101', '103', '105', '999']) ok.members.set(id, mock.members.get(id) ?? mock.members.get('999'));
    mock.addRole('R_DENY', 'No participa', '#ed4245');
    mock.addRole('R_VIP', 'VIP', '#faa61a');
    mock.addRole('R_STAFF', 'Staff', '#5865f2');
    mock.addChannel('C_COUNT', 'confirmados');
    mock.addChannel('C_NEWS', 'novedades');
    mock.addChannel('C_GEN', 'general');

    const db = openDb();
    const manager = new ModuleManager(mock.client, db);
    const messages = new MessagesService(mock.client, db);
    const confirmations = new ConfirmationService(mock.client, db, messages);
    const inbox = new InboxService(db, messages);
    const scheduler = new SchedulerService(db, messages, confirmations);
    const servers = new ServersService(mock.client, db, confirmations);
    setServices({ messages, confirmations, servers });
    manager.register(createMessagesModule(messages, db));
    manager.register(createInboxModule(inbox, messages, db));
    manager.register(createSchedulerModule(scheduler));
    manager.register(createConfirmationsModule(confirmations));
    manager.register(createServersModule(servers));
    migrateLegacy(db);

    // Servidores de juego de ejemplo: un Minecraft falso (con métricas Spark) y uno apagado.
    startFakeMinecraft(38250, { online: 5, max: 20, players: ['Steve_MC', 'AlexG', 'LunaCraft', 'ZoeMC', 'Herobrine'], version: 'Paper 1.21.1', motd: 'MCKB Survival · Temporada 3' });
    startFakeSpark(38251, 18.6);
    const addServer = db.prepare("INSERT INTO game_servers (name, type, host, port, api_port, enabled, link_players, channel_id, message_id, created_at) VALUES (?, ?, '127.0.0.1', ?, ?, 1, 1, ?, ?, ?)");
    addServer.run('MCKB Survival', 'minecraft', 38250, 38251, 'C_GEN', 'M_STATUS', Date.now());
    addServer.run('Hytale MCKB', 'hytale', null, 38252, null, null, Date.now());
    await manager.startEnabled();

    // ── Datos de ejemplo ──
    const imgPath = path.join(UPLOADS_DIR, 'demo-capture.png');
    fs.writeFileSync(imgPath, png(320, 180, (x, y) => [60 + Math.round(x / 3), 90 + Math.round(y / 2), 220 - Math.round(x / 4)]));
    const img = registerFile(db, { name: 'captura.png', mime: 'image/png', size: fs.statSync(imgPath).size, path: imgPath });

    const ago = (min: number) => Date.now() - min * 60_000;
    const rec = (userId: string, direction: 'in' | 'out', content: string, minutesAgo: number, opts: { fileIds?: string[]; source?: string; failed?: boolean } = {}) => {
        const name = people.find(p => p[0] === userId)![1];
        const r = messages.record({
            direction, kind: 'dm', userId, userTag: name, payload: { content }, status: direction === 'in' ? 'received' : opts.failed ? 'failed' : 'sent',
            error: opts.failed ? 'El usuario tiene los mensajes directos cerrados (o ha bloqueado al bot).' : undefined,
            meta: { source: (opts.source ?? (direction === 'in' ? 'dm' : 'reply')) as never }, fileIds: opts.fileIds,
        });
        db.prepare('UPDATE messages SET created_at = ?, read_at = ? WHERE id = ?').run(ago(minutesAgo), direction === 'in' && minutesAgo > 120 ? ago(minutesAgo - 1) : null, r.id);
    };
    rec('101', 'in', 'Hola! No me ha llegado el formulario de confirmación, ¿me lo puedes reenviar?', 1500);
    rec('101', 'out', 'Claro, te lo reenvío ahora mismo 👍', 1490);
    rec('101', 'in', '¡Ya está, gracias!', 1480);
    rec('102', 'in', 'Buenas, ¿cuándo abre el servidor de Hytale?', 95);
    rec('102', 'in', 'Os dejo una captura del error que me sale al conectar', 94, { fileIds: [img.id] });
    rec('102', 'in', 'Es el mismo desde ayer', 93);
    rec('103', 'in', 'Gracias por el evento de ayer, estuvo genial 🎉', 340);
    rec('103', 'out', '¡Me alegro mucho! Pronto habrá más.', 330);
    rec('104', 'out', 'Recordatorio: mañana a las 18:00 evento en el servidor.', 600, { source: 'manual', failed: true });
    for (const [id] of people.slice(0, 6)) rec(id, 'out', '', 1440 * 1, { source: 'campaign' });
    db.prepare("UPDATE messages SET content = '' WHERE source = 'campaign'").run();
    const tpl = db.prepare("INSERT INTO templates (name, content, embed_json, file_ids, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)");
    tpl.run('Recordatorio de evento', 'Hola {user}, mañana a las 18:00 tenemos evento en {server}. ¡No faltes!', null, ago(3000), ago(300));
    tpl.run('Normas del servidor', '', JSON.stringify({ title: '📜 Normas', description: '1. Respeta a todos.\n2. Sin spam.\n3. Diviértete.', color: '#5865f2', footer: 'Equipo MCKBServers' }), ago(5000), ago(5000));
    scheduler.create({
        name: 'Aviso semanal del evento', enabled: true, scheduleType: 'cron', schedule: '0 18 * * 5', startAt: null, timezone: 'Europe/Madrid',
        actionType: 'send_template', action: { templateId: 1, target: { type: 'role', id: 'R_OK' } },
    });
    scheduler.create({
        name: 'Normas cada 3 días', enabled: false, scheduleType: 'interval', schedule: String(3 * 86400), startAt: Date.now() + 86400_000, timezone: 'Europe/Madrid',
        actionType: 'send_template', action: { templateId: 2, target: { type: 'all' } },
    });
    db.prepare("UPDATE jobs SET last_run_at = ?, last_status = 'ok', last_result = '5 enviados, 0 fallidos (de 5).', run_count = 12 WHERE id = 1").run(ago(60 * 22));

    startWebServer({ client: mock.client, db, manager });
    console.log(`\n  Panel de demostración: http://localhost:${PORT}  (datos temporales en ${tmp})\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
