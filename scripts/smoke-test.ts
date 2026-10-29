/**
 * Prueba de humo SIN Discord real: arranca el panel y los módulos con un cliente de Discord simulado
 * y comprueba los flujos principales (enviar, bandeja, programación en caliente, confirmaciones, seguridad).
 *
 *   npm run smoke
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbot-smoke-'));
fs.mkdirSync(path.join(tmp, 'data'));
fs.writeFileSync(path.join(tmp, 'data', 'names.json'), JSON.stringify({ steve_dc: 'Steve', alex_dc: 'Alex', ghost_dc: 'Ghost' }));
fs.writeFileSync(path.join(tmp, 'data', 'denied_reasons.json'), JSON.stringify({ nope_dc: 'No me apetece' }));
fs.writeFileSync(path.join(tmp, 'data', 'config.json'), JSON.stringify({
    rolContadoID: 'R_OK', canalID: 'C_COUNT', mensajeID: 'M_COUNT', canalInfoID: 'C1', mensajeInfoID: 'M_INFO',
    // Roles por reacción antiguos (/setreaction): el emoji personalizado solo guardaba el nombre.
    reactions: [
        { canalID: 'C1', mensajeID: 'M_OLD', rolID: 'R_PING', emoji: 'kbheart' },
        { canalID: 'C1', mensajeID: 'M_OLD', rolID: 'R_NEWS', emoji: '📰' },
    ],
}));
process.chdir(tmp);

const PORT = 38123;
Object.assign(process.env, {
    TOKEN: 'x', CLIENT_ID: '1', GUILD_ID: 'G1', ADMIN_ID: 'ADMIN', PANEL_PORT: String(PORT), PANEL_URL: `http://127.0.0.1:${PORT}`,
    PANEL_DEV_AUTH: '1', NODE_ENV: 'test', PANEL_HOST: '127.0.0.1',
    // Variables antiguas del estado del servidor: se importan una vez como servidor de juego.
    SERVER_TYPE: 'MINECRAFT', MINECRAFT_SERVER_IP: '127.0.0.1', MINECRAFT_SERVER_PORT: '38200', MINECRAFT_API_PORT: '38201',
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const src = (p: string) => path.resolve(__dirname, '..', 'src', p);

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    const { Collection, ChannelType } = await import('discord.js');
    const { createMockDiscord } = await import('./mock-discord');
    const { openDb } = await import(src('core/db'));
    const { ModuleManager } = await import(src('core/module'));
    const { MessagesService, createMessagesModule } = await import(src('modules/messages'));
    const { InboxService, createInboxModule } = await import(src('modules/inbox'));
    const { ConfirmationService } = await import(src('modules/confirmations/service'));
    const { createConfirmationsModule } = await import(src('modules/confirmations'));
    const { SchedulerService } = await import(src('modules/scheduler/service'));
    const { createSchedulerModule } = await import(src('modules/scheduler'));
    const { ServersService, createServersModule } = await import(src('modules/servers'));
    const { ReactionRolesService, createReactionsModule } = await import(src('modules/reactions'));
    const { startFakeMinecraft, startFakeSpark } = await import('./fake-game-servers');
    const { startWebServer } = await import(src('web/server'));
    const { migrateLegacy, migrateReactions, migrateServers } = await import(src('core/migrateLegacy'));
    const { setServices } = await import(src('core/services'));
    const { startLogCapture } = await import(src('core/logs'));
    startLogCapture();

    // ── Discord simulado ──
    const mock = createMockDiscord('G1');
    const { client, members, sent, roleLog, nickLog, channelsSent, counterEdits } = mock;
    for (const [id, name] of [['U1', 'steve_dc'], ['U2', 'alex_dc'], ['U3', 'newbie_dc'], ['CLOSED', 'closed_dc']]) mock.addMember(id, name);
    mock.addMember('U4', 'done_dc', ['R_OK']);
    mock.mkUser('ADMIN', 'admin');
    const roleOk = mock.addRole('R_OK', 'Confirmado', '#00ff00');
    roleOk.members.set('U4', members.get('U4'));
    const roleAll = mock.addRole('R_ALL', 'Todos', '#ffffff');
    for (const i of ['U1', 'U2', 'U3']) roleAll.members.set(i, members.get(i));
    mock.addChannel('C1', 'general');
    mock.addChannel('C_COUNT', 'contador');
    for (const [id, name] of [['R_PING', 'Avisos'], ['R_NEWS', 'Noticias'], ['R_A', 'A'], ['R_VER', 'Verificado'], ['R_UNVER', 'Sin verificar'], ['R_B', 'B'], ['R_C', 'C'], ['R_RED', 'Rojo'], ['R_BLUE', 'Azul']]) mock.addRole(id, name);
    mock.addEmoji('111111111111111111', 'kbheart');

    // ── Servicios (igual que index.ts) ──
    const db = openDb();
    const manager = new ModuleManager(client, db);
    const messages = new MessagesService(client, db);
    const confirmations = new ConfirmationService(client, db, messages);
    const inbox = new InboxService(db, messages);
    const scheduler = new SchedulerService(db, messages, confirmations);
    const gameServers = new ServersService(client, db, confirmations);
    const reactions = new ReactionRolesService(client, db);
    setServices({ messages, confirmations, servers: gameServers, reactions });
    manager.register(createMessagesModule(messages, db));
    manager.register(createInboxModule(inbox, messages, db));
    manager.register(createSchedulerModule(scheduler));
    manager.register(createConfirmationsModule(confirmations));
    manager.register(createServersModule(gameServers));
    manager.register(createReactionsModule(reactions));
    const fakeMc = startFakeMinecraft(38200, { online: 2, max: 20, players: ['Steve', 'Alex'], version: 'Paper 1.21.1', motd: 'MCKB Survival' });
    const fakeSpark = startFakeSpark(38201);
    migrateLegacy(db);
    migrateLegacy(db); // idempotente
    migrateServers(db);
    migrateServers(db); // idempotente
    migrateReactions(db);
    migrateReactions(db); // idempotente
    await manager.startEnabled();
    const server = startWebServer({ client, db, manager });
    await new Promise(r => server.once('listening', r));

    // Servidor local para simular el CDN de Discord (adjuntos entrantes)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const cdn = http.createServer((_q, r) => { r.setHeader('Content-Type', 'image/png'); r.end(png); }).listen(38124);

    // ── Cliente HTTP ──
    const base = `http://127.0.0.1:${PORT}`;
    let cookie = '';
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
        const isForm = body instanceof FormData;
        const res = await fetch(base + url, {
            method,
            redirect: 'manual',
            headers: { cookie, 'x-requested-with': 'kb-panel', ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headers },
            body: body ? (isForm ? body : JSON.stringify(body)) as any : undefined,
        });
        const text = await res.text();
        let json: any; try { json = JSON.parse(text); } catch { json = text; }
        return { status: res.status, json, headers: res.headers };
    };

    console.log('\nSeguridad y acceso');
    assert.equal((await call('GET', '/api/status', undefined, { cookie: '' })).status, 401);
    ok('API protegida sin sesión (401)');
    const login = await fetch(`${base}/auth/dev-login`, { redirect: 'manual' });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^kb_session=/);
    ok('login de desarrollo crea sesión');
    assert.equal((await call('POST', '/api/modules/inbox/enabled', { enabled: true }, { 'x-requested-with': '' })).status, 403);
    ok('POST sin cabecera CSRF rechazado (403)');

    console.log('\nMigración de datos antiguos');
    const campaigns = (await call('GET', '/api/confirmations/campaigns')).json;
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].legacy, true);
    assert.equal(campaigns[0].confirmedRoleId, 'R_OK');
    const entries = (await call('GET', `/api/confirmations/campaigns/${campaigns[0].id}/entries`)).json;
    assert.equal(entries.length, 4);
    assert.equal(entries.find((e: any) => e.username === 'steve_dc').userId, 'U1', 'steve_dc se resuelve a su ID real');
    assert.ok(entries.find((e: any) => e.username === 'ghost_dc').unresolved, 'ghost_dc (ya no está) queda sin resolver');
    assert.equal(confirmations.usernameForAnswer('steve'), 'steve_dc');
    ok('campaña por defecto + 3 confirmados + 1 rechazo importados y resueltos');
    const jobs = (await call('GET', '/api/scheduler/jobs')).json;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].schedule, '0 14 * * *');
    assert.ok(jobs[0].nextRunAt > Date.now());
    ok('el cron diario de las 14:00 pasa a ser una tarea editable');

    console.log('\nEnviar mensajes');
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'foto.png');
    const up = await call('POST', '/api/files', fd);
    assert.equal(up.status, 201);
    const fileId = up.json[0].id;
    const img = await call('GET', `/api/files/${fileId}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    ok('subida y descarga de imagen');

    const html = new FormData();
    html.append('files', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
    const upHtml = await call('POST', '/api/files', html);
    const htmlRes = await call('GET', `/api/files/${upHtml.json[0].id}`);
    assert.equal(htmlRes.headers.get('content-type'), 'application/octet-stream');
    assert.match(htmlRes.headers.get('content-disposition') ?? '', /^attachment/);
    ok('un HTML subido nunca se sirve inline (anti-XSS)');

    const r1 = await call('POST', '/api/messages/send', {
        target: { type: 'user', id: 'U3' },
        payload: { content: 'Hola {user}!', fileIds: [fileId], embed: { title: 'Aviso', description: 'Para {username}', color: '#ff0000' } },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.status, 'sent');
    const last = sent.at(-1)!;
    assert.equal(last.to, 'U3');
    assert.equal(last.opts.content, 'Hola NEWBIE_DC!');
    assert.equal(last.opts.files.length, 1);
    assert.equal(last.opts.embeds[0].data.description, 'Para newbie_dc');
    ok('DM con texto + embed + imagen y variables {user}/{username}');

    const failed = await call('POST', '/api/messages/send', { target: { type: 'user', id: 'CLOSED' }, payload: { content: 'hey' } });
    assert.equal(failed.json.status, 'failed');
    assert.match(failed.json.error, /mensajes directos cerrados/);
    ok('MD cerrado queda registrado como fallido con motivo legible');

    assert.equal((await call('POST', '/api/messages/send', { target: { type: 'user', id: 'U3' }, payload: { content: '   ' } })).status, 400);
    ok('mensaje vacío rechazado');

    const chan = await call('POST', '/api/messages/send', { target: { type: 'channel', id: 'C1' }, payload: { content: 'Anuncio' } });
    assert.equal(chan.json.kind, 'channel');
    assert.equal(channelsSent.length, 1);
    ok('envío a canal');

    const before = sent.length;
    const bulk = await call('POST', '/api/messages/send', { target: { type: 'role', id: 'R_ALL' }, payload: { content: 'Para todos' } });
    assert.equal(bulk.status, 202);
    assert.equal(bulk.json.total, 3);
    for (let i = 0; i < 40 && (await call('GET', `/api/messages/batches/${bulk.json.batchId}`)).json.finished !== true; i++) await sleep(250);
    assert.equal(sent.length - before, 3);
    ok('envío masivo a un rol (3 destinatarios) con lote y progreso');

    const hist = (await call('GET', '/api/messages/history?direction=out&q=Todos')).json;
    assert.equal(hist.length, 3);
    ok('historial con búsqueda');

    console.log('\nBandeja de entrada');
    const dm = (id: string, content: string, withImage = false) => ({
        author: { bot: false, id, username: `user-${id}`, displayAvatarURL: () => 'a.png' },
        channel: { type: ChannelType.DM }, content, id: `dm-${Math.random()}`,
        attachments: new Collection(withImage ? [['a1', { url: 'http://127.0.0.1:38124/pic.png', name: 'pic.png', contentType: 'image/png', size: png.length }]] : []),
    });
    client.emit('messageCreate', dm('U3', 'Necesito ayuda', true));
    await sleep(400);
    const inboxList = (await call('GET', '/api/inbox/conversations')).json;
    const conv = inboxList.conversations.find((c: any) => c.userId === 'U3');
    assert.equal(conv.unread, 1);
    assert.equal(conv.preview, 'Necesito ayuda');
    const thread = (await call('GET', '/api/inbox/conversations/U3')).json;
    const incoming = thread.find((m: any) => m.direction === 'in');
    assert.equal(incoming.files.length, 1);
    assert.ok(incoming.files[0].url.startsWith('/api/files/'), 'la imagen recibida se guarda localmente');
    assert.equal((await call('GET', incoming.files[0].url)).headers.get('content-type'), 'image/png');
    assert.ok(sent.some(s => s.to === 'ADMIN' && s.opts.components), 'se reenvía al admin con botón Responder');
    ok('MD recibido con imagen: guardado, imagen descargada y reenviado al admin');

    const rep = await call('POST', '/api/inbox/conversations/U3/reply', { content: 'Claro, dime', fileIds: [fileId] });
    assert.equal(rep.json.status, 'sent');
    assert.equal(rep.json.source, 'reply');
    assert.equal((await call('GET', '/api/inbox/conversations')).json.conversations.find((c: any) => c.userId === 'U3').unread, 0);
    ok('responder desde el panel (con imagen) y marcar como leído');

    const campaignNoise = (await call('GET', '/api/inbox/conversations')).json.conversations.map((c: any) => c.userId);
    assert.ok(!campaignNoise.includes('U1'), 'los MD automáticos masivos no ensucian la bandeja');
    ok('la bandeja solo muestra conversaciones reales');

    console.log('\nProgramación en caliente');
    const tpl = (await call('POST', '/api/messages/templates', { name: 'Recordatorio', content: 'No olvides {user}', fileIds: [] })).json;
    const created = await call('POST', '/api/scheduler/jobs', {
        name: 'Test intervalo', scheduleType: 'interval', schedule: '259200', startAt: Date.now() - 86400_000, timezone: 'Europe/Madrid',
        actionType: 'send_template', action: { templateId: tpl.id, target: { type: 'user', id: 'U2' } },
    });
    assert.equal(created.status, 201);
    const job = created.json;
    assert.ok(job.nextRunAt > Date.now() && job.nextRunAt - Date.now() <= 172800_000 + 1000);
    ok('intervalo "cada 3 días" anclado: la próxima ejecución es coherente');

    const edited = await call('PUT', `/api/scheduler/jobs/${job.id}`, { ...job, scheduleType: 'cron', schedule: '*/5 * * * *', startAt: null });
    assert.equal(edited.status, 200);
    assert.ok(edited.json.nextRunAt - Date.now() <= 300_000);
    ok('cambiar la frecuencia re-programa sin reiniciar');

    const off = await call('POST', `/api/scheduler/jobs/${job.id}/enabled`, { enabled: false });
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.nextRunAt, null);
    const on = await call('POST', `/api/scheduler/jobs/${job.id}/enabled`, { enabled: true });
    assert.ok(on.json.nextRunAt);
    ok('pausar / reanudar');

    const b4 = sent.length;
    assert.equal((await call('POST', `/api/scheduler/jobs/${job.id}/run`)).status, 202);
    await sleep(500);
    assert.equal(sent.length - b4, 1);
    assert.equal((await call('GET', '/api/scheduler/jobs')).json.find((j: any) => j.id === job.id).lastStatus, 'ok');
    ok('ejecutar ahora');

    assert.equal((await call('POST', '/api/scheduler/jobs', { ...job, schedule: 'esto no es cron', scheduleType: 'cron' })).status, 400);
    assert.equal((await call('POST', '/api/scheduler/preview', { scheduleType: 'cron', schedule: '0 9 * * 1,3', timezone: 'Europe/Madrid' })).json.runs.length, 5);
    assert.equal((await call('DELETE', `/api/messages/templates/${tpl.id}`)).status, 409);
    ok('validación de cron, vista previa y protección de plantillas en uso');

    console.log('\nConfirmaciones');
    const legacyId = campaigns[0].id;
    // Botón y modal de MD antiguos (enviados antes de actualizar) siguen funcionando
    let modal: any;
    client.emit('interactionCreate', { isButton: () => true, isModalSubmit: () => false, isRepliable: () => true, customId: 'open_confirmation_modal', showModal: async (m: any) => { modal = m; } });
    await sleep(100);
    assert.ok(modal, 'el botón antiguo abre el formulario');
    const replies: string[] = [];
    client.emit('interactionCreate', {
        isButton: () => false, isModalSubmit: () => true, isRepliable: () => true, customId: 'confirmation_modal', user: members.get('U3').user,
        fields: { fields: new Collection([['confirmation_input', { value: 'NewSteve' }]]) },
        deferReply: async () => undefined, editReply: async (m: string) => replies.push(m),
    });
    await sleep(300);
    assert.ok(roleLog.includes('+U3:R_OK'));
    assert.ok(nickLog.some(n => n === 'U3:NEWBIE_DC (NewSteve)'));
    assert.equal(confirmations.usernameForAnswer('newsteve'), 'newbie_dc');
    assert.match(replies[0], /Gracias/);
    ok('formularios antiguos siguen vivos: guarda respuesta, da rol y pone apodo');

    await sleep(2300);
    assert.ok(counterEdits.length >= 1, 'el contador se actualiza');
    ok('contador actualizado (agrupado)');

    const del = await call('POST', `/api/confirmations/campaigns/${legacyId}/entries/delete`, { userIds: ['U3'], removeRole: true, resetNickname: true });
    assert.equal(del.json.removed, 1);
    assert.ok(roleLog.includes('-U3:R_OK'));
    assert.ok(nickLog.includes('U3:null'));
    ok('borrar un confirmado: quita rol y apodo');

    const camp2 = await call('POST', '/api/confirmations/campaigns', {
        name: 'Hytale', title: 'Hytale', description: 'Hola {user}', confirmedRoleId: 'R_H', allowDeny: false, sendOnJoin: false, setNickname: false,
    });
    assert.equal(camp2.status, 201);
    const stats = (await call('GET', `/api/confirmations/campaigns/${camp2.json.id}/stats`)).json;
    assert.equal(stats.pending, 5, 'los 5 miembros humanos aún no han respondido a esta campaña');
    const b5 = sent.length;
    await call('POST', `/api/confirmations/campaigns/${camp2.json.id}/send`, { userIds: ['U1'] });
    await sleep(300);
    const form = sent[b5];
    assert.equal(form.to, 'U1');
    assert.equal(form.opts.components[0].components[0].data.custom_id, `cf:open:${camp2.json.id}`);
    assert.equal(form.opts.components[0].components.length, 1, 'sin botón de rechazo');
    ok('varias campañas a la vez, cada una con sus botones');

    // Campaña solo para quien tenga un rol (p. ej. preguntar el modpack solo a los confirmados) y con respuesta larga
    const camp3 = await call('POST', '/api/confirmations/campaigns', {
        name: 'Modpack', title: '¿Qué modpack?', description: 'Cuéntanos', includeRoleIds: ['R_OK'], inputLong: true, allowDeny: false, sendOnJoin: true, setNickname: false,
    });
    assert.equal(camp3.status, 201);
    assert.deepEqual(camp3.json.includeRoleIds, ['R_OK']);
    assert.equal(camp3.json.inputLong, true);
    const stats3 = (await call('GET', `/api/confirmations/campaigns/${camp3.json.id}/stats`)).json;
    assert.equal(stats3.pending, 1, 'solo U4 tiene el rol R_OK');
    const b6 = sent.length;
    assert.equal((await call('POST', `/api/confirmations/campaigns/${camp3.json.id}/send`, {})).json.total, 1);
    await sleep(400);
    assert.deepEqual(sent.slice(b6).map(x => x.to), ['U4']);
    ok('campaña con "solo a quien tenga estos roles": envía solo a los confirmados');

    let longModal: any;
    client.emit('interactionCreate', { isButton: () => true, isModalSubmit: () => false, isRepliable: () => true, customId: `cf:open:${camp3.json.id}`, showModal: async (m: any) => { longModal = m; } });
    await sleep(100);
    const input = longModal.components[0].components[0].data;
    assert.equal(input.style, 2, 'párrafo');
    assert.equal(input.max_length, 1000);
    const longAnswer = 'All the Mods 10, porque '.padEnd(600, 'x');
    const longReplies: string[] = [];
    client.emit('interactionCreate', {
        isButton: () => false, isModalSubmit: () => true, isRepliable: () => true, customId: `cf:modal:${camp3.json.id}`, user: members.get('U4').user,
        fields: { fields: new Collection([['answer', { value: longAnswer }]]) },
        deferReply: async () => undefined, editReply: async (m: string) => longReplies.push(m),
    });
    await sleep(300);
    const e3 = (await call('GET', `/api/confirmations/campaigns/${camp3.json.id}/entries`)).json;
    assert.equal(e3[0].answer, longAnswer);
    ok('respuesta larga: formulario de párrafo y se guarda entera');

    const newbie = mock.addMember('U5', 'fresh_dc');
    const b7 = sent.length;
    client.emit('guildMemberAdd', newbie);
    await sleep(300);
    assert.ok(!sent.slice(b7).some(x => x.to === 'U5' && x.opts.components?.[0]?.components?.[0]?.data?.custom_id === `cf:open:${camp3.json.id}`));
    members.delete('U5');
    ok('al unirse, no se envía una campaña con roles obligatorios a quien no los tiene');

    console.log('\nServidores de juego');
    const sv = (await call('GET', '/api/servers')).json;
    assert.equal(sv.servers.length, 1, 'el servidor del .env se importa una sola vez');
    const mcId = sv.servers[0].id;
    assert.equal(sv.servers[0].host, '127.0.0.1');
    assert.equal(sv.servers[0].messageId, 'M_INFO', 'se conserva el mensaje de estado que ya existía');
    ok('migración del .env y config.json antiguos');

    const edits0 = counterEdits.length;
    const chk = (await call('POST', `/api/servers/${mcId}/check`)).json;
    assert.equal(chk.online, true);
    assert.equal(chk.playersOnline, 2);
    assert.equal(chk.version, 'Paper 1.21.1');
    assert.equal(chk.tps.m1, 19.84);
    assert.equal(chk.cpu, 0.37);
    assert.equal(chk.players.find((p: any) => p.name === 'Steve').discordId, 'U1', 'Steve → steve_dc por su respuesta de confirmación');
    const embed = counterEdits.slice(edits0).map((o: any) => o.embeds?.[0]?.data).find((d: any) => /Estado de Minecraft/.test(d?.title ?? ''));
    assert.ok(embed, 'se edita el mensaje de estado');
    assert.ok(embed.fields.some((f: any) => f.value.includes('<@U1>')));
    ok('consulta online: jugadores, versión, TPS/CPU, menciones y mensaje en Discord');

    assert.equal((await call('POST', '/api/servers', { name: 'H', type: 'hytale', host: 'x.com' })).status, 400);
    const down = await call('POST', '/api/servers', { name: 'Caído', type: 'minecraft', host: 'http://127.0.0.1:38299/' });
    assert.equal(down.status, 201);
    assert.equal(down.json.port, 38299, 'acepta host:puerto y quita http://');
    const t0 = Date.now();
    const downSt = (await call('POST', `/api/servers/${down.json.id}/check`)).json;
    assert.equal(downSt.online, false);
    assert.match(downSt.error, /rechazada/);
    assert.ok(Date.now() - t0 < 2000, 'un servidor caído responde rápido');
    assert.equal((await call('POST', '/api/servers/test', { type: 'minecraft', host: '127.0.0.1', port: 38200 })).json.online, true);
    ok('validación, servidor caído y "probar conexión"');

    assert.equal((await call('PUT', '/api/servers/settings', { intervalSec: 5 })).status, 400);
    assert.equal((await call('PUT', '/api/servers/settings', { intervalSec: 60 })).json.intervalSec, 60);
    const ch0 = channelsSent.length;
    assert.equal((await call('POST', `/api/servers/${down.json.id}/message`, { channelId: 'C1' })).json.channelId, 'C1');
    assert.equal(channelsSent.length, ch0 + 1);
    assert.equal((await call('POST', `/api/servers/${down.json.id}/message/unlink`)).json.messageId, null);
    assert.equal((await call('DELETE', `/api/servers/${down.json.id}`)).status, 200);
    ok('frecuencia, publicar / soltar mensaje de estado y eliminar');

    await call('POST', '/api/modules/servers/enabled', { enabled: false });
    assert.equal((await call('POST', `/api/servers/${mcId}/check`)).status, 409);
    assert.equal((await call('GET', '/api/servers')).status, 200);
    await call('POST', '/api/modules/servers/enabled', { enabled: true });
    ok('módulo de servidores activable en caliente');

    console.log('\nRoles por reacción');
    const has = (u: string, r: string) => members.get(u).roles.cache.has(r);
    const react = async (m: string, e: string, u: string, add = true) => { mock.userReact(m, e, u, add); await sleep(60); };
    const HEART = '<:kbheart:111111111111111111>';

    let panels = (await call('GET', '/api/reactions')).json.panels;
    assert.equal(panels.length, 1, 'un panel por mensaje antiguo');
    assert.equal(panels[0].legacy, true);
    assert.equal(panels[0].messageId, 'M_OLD');
    assert.equal(panels[0].manageEmbed, false, 'el mensaje antiguo no se reescribe');
    assert.deepEqual(panels[0].entries.map((e: any) => [e.emoji, e.roleId, e.behavior]), [[HEART, 'R_PING', 'toggle'], ['📰', 'R_NEWS', 'toggle']]);
    ok('los roles por reacción de config.json se importan (y el emoji personalizado recupera su ID)');

    await react('M_OLD', HEART, 'U3');
    assert.ok(has('U3', 'R_PING'));
    await react('M_OLD', HEART, 'U3', false);
    assert.ok(!has('U3', 'R_PING'));
    ok('normal: reaccionar da el rol y quitar la reacción lo quita (como antes)');

    assert.equal((await call('POST', '/api/reactions', { name: 'X', channelId: 'C1', entries: [{ emoji: ':nope:', roleId: 'R_A' }] })).status, 400);
    assert.equal((await call('POST', '/api/reactions', { name: 'X', channelId: 'C1', entries: [] })).status, 400);
    assert.equal((await call('POST', '/api/reactions', { name: 'X', channelId: 'C1', entries: [{ emoji: '🅰️', roleId: 'R_A', behavior: 'magic' }] })).status, 400);
    ok('validación (emoji inexistente, sin reacciones, comportamiento desconocido)');

    const ch1 = channelsSent.length;
    const rxNew = await call('POST', '/api/reactions', {
        name: 'Roles', channelId: 'C1', source: 'new', title: 'Elige tus roles', description: 'Reacciona abajo', color: '#ff0000',
        entries: [
            { emoji: '🅰️', roleId: 'R_A', behavior: 'add' },
            { emoji: '✅', roleId: 'R_VER', behavior: 'add', label: 'Acepto las normas' },
            { emoji: '✅', roleId: 'R_UNVER', behavior: 'remove' },
            { emoji: ':kbheart:', roleId: 'R_B', behavior: 'click' },
            { emoji: '🔁', roleId: 'R_C', behavior: 'reverse' },
        ],
    });
    assert.equal(rxNew.status, 201, JSON.stringify(rxNew.json));
    assert.deepEqual(rxNew.json.warnings, []);
    const P = rxNew.json.panel;
    assert.equal(channelsSent.length, ch1 + 1);
    assert.match(channelsSent.at(-1).embeds[0].data.description, /✅ → <@&R_VER> — Acepto las normas · \*permanente\*/);
    assert.equal(P.entries[3].emoji, HEART, ':nombre: se convierte en el emoji del servidor');
    const msgP = mock.getMessage(P.messageId);
    assert.equal(msgP.reactions.cache.filter((r: any) => r.me).size, 4, 'el bot pone una reacción por emoji distinto');
    ok('crear y publicar un mensaje con varias reacciones');

    await react(P.messageId, '🅰️', 'U1');
    await react(P.messageId, '🅰️', 'U1', false);
    assert.ok(has('U1', 'R_A'));
    ok('permanente: quitar la reacción no quita el rol');

    members.get('U2').roles.cache.set('R_UNVER', { id: 'R_UNVER' });
    await react(P.messageId, '✅', 'U2');
    assert.ok(has('U2', 'R_VER') && !has('U2', 'R_UNVER'));
    await react(P.messageId, '✅', 'U2', false);
    assert.ok(has('U2', 'R_VER') && !has('U2', 'R_UNVER'));
    ok('un mismo emoji puede dar un rol y quitar otro ("verificarse")');

    await react(P.messageId, HEART, 'U1');
    assert.ok(has('U1', 'R_B'));
    assert.ok(!msgP.reactions.cache.get('111111111111111111').userIds.has('U1'), 'el bot borra la reacción');
    assert.ok(has('U1', 'R_B'), 'borrar la reacción no quita el rol');
    await react(P.messageId, HEART, 'U1');
    assert.ok(!has('U1', 'R_B'));
    ok('pulsar: cada reacción da o quita el rol y la reacción desaparece');

    members.get('U1').roles.cache.set('R_C', { id: 'R_C' });
    await react(P.messageId, '🔁', 'U1');
    assert.ok(!has('U1', 'R_C'));
    await react(P.messageId, '🔁', 'U1', false);
    assert.ok(has('U1', 'R_C'));
    ok('invertido: reaccionar quita el rol y quitar la reacción lo devuelve');

    const ex = (await call('POST', '/api/reactions', {
        name: 'Equipo', channelId: 'C1', exclusive: true,
        entries: [{ emoji: '🔴', roleId: 'R_RED' }, { emoji: '🔵', roleId: 'R_BLUE' }],
    })).json.panel;
    await react(ex.messageId, '🔴', 'U3');
    await react(ex.messageId, '🔵', 'U3');
    assert.ok(has('U3', 'R_BLUE') && !has('U3', 'R_RED'));
    assert.ok(!mock.getMessage(ex.messageId).reactions.cache.get('🔴').userIds.has('U3'), 'se quita la reacción anterior');
    assert.ok(has('U3', 'R_BLUE'), 'quitar la reacción anterior no afecta al rol nuevo');
    ok('exclusivo: elegir otro rol quita el anterior y su reacción');

    await call('POST', `/api/reactions/${ex.id}/enabled`, { enabled: false });
    await react(ex.messageId, '🔴', 'U2');
    assert.ok(!has('U2', 'R_RED'));
    await call('POST', `/api/reactions/${ex.id}/enabled`, { enabled: true });
    ok('pausar un mensaje deja de reaccionar sin borrarlo');

    const upd = await call('PUT', `/api/reactions/${P.id}`, { ...P, entries: P.entries.filter((e: any) => e.emoji !== '🅰️') });
    assert.equal(upd.status, 200);
    assert.ok(!msgP.reactions.cache.get('🅰️').me, 'el bot retira su reacción del emoji eliminado');
    assert.ok(has('U1', 'R_A'), 'quien ya tenía el rol lo conserva');
    ok('editar: quitar una reacción no le quita el rol a nadie');

    const linked = await call('POST', '/api/reactions', { name: 'Ajeno', source: 'existing', channelId: 'C1', messageId: 'https://discord.com/channels/G1/C1/12345678901234567', entries: [{ emoji: '🎮', roleId: 'R_A' }] });
    assert.equal(linked.status, 201);
    assert.equal(linked.json.panel.messageId, '12345678901234567');
    assert.equal(linked.json.panel.manageEmbed, false);
    assert.ok(mock.getMessage('12345678901234567').reactions.cache.get('🎮').me);
    assert.equal((await call('POST', '/api/reactions', { name: 'Ajeno', source: 'existing', channelId: 'C1', messageId: '12345678901234567', entries: [{ emoji: '🎮', roleId: 'R_A' }] })).status, 400);
    assert.equal((await call('POST', '/api/reactions', { name: 'Ajeno', source: 'existing', channelId: 'C1', messageId: '99999999999999999', entries: [{ emoji: '🎮', roleId: 'R_A' }] })).status, 400);
    ok('usar un mensaje que ya existe (por enlace o ID)');

    assert.equal((await call('DELETE', `/api/reactions/${ex.id}?message=1`)).status, 200);
    assert.ok(mock.deletedMessages.includes(ex.messageId));
    assert.ok(has('U3', 'R_BLUE'), 'borrar no quita roles');
    await call('POST', '/api/modules/reactions/enabled', { enabled: false });
    await react('M_OLD', '📰', 'U3');
    assert.ok(!has('U3', 'R_NEWS'));
    assert.equal((await call('POST', `/api/reactions/${P.id}/sync`)).status, 409);
    await call('POST', '/api/modules/reactions/enabled', { enabled: true });
    await react('M_OLD', '📰', 'U3');
    assert.ok(has('U3', 'R_NEWS'));
    ok('eliminar mensaje y desactivar el módulo en caliente');

    console.log('\nMódulos en caliente');
    await call('POST', '/api/modules/messages/enabled', { enabled: false });
    assert.equal((await call('POST', '/api/messages/send', { target: { type: 'user', id: 'U1' }, payload: { content: 'x' } })).status, 409);
    assert.equal((await call('GET', '/api/messages/history')).status, 200);
    await call('POST', '/api/modules/messages/enabled', { enabled: true });
    assert.equal((await call('POST', '/api/messages/send', { target: { type: 'user', id: 'U1' }, payload: { content: 'x' } })).status, 200);
    ok('desactivar "Mensajes" pausa todos los envíos; el historial sigue visible');

    await call('POST', '/api/modules/inbox/enabled', { enabled: false });
    const n = (await call('GET', '/api/inbox/conversations')).json.conversations.length;
    client.emit('messageCreate', dm('U2', 'ignorado'));
    await sleep(200);
    assert.equal((await call('GET', '/api/inbox/conversations')).json.conversations.length, n);
    await call('POST', '/api/modules/inbox/enabled', { enabled: true });
    client.emit('messageCreate', dm('U2', 'ahora sí'));
    await sleep(300);
    assert.ok((await call('GET', '/api/inbox/conversations')).json.conversations.some((c: any) => c.userId === 'U2'));
    ok('desactivar/activar la bandeja quita y pone el listener al instante');

    const st = (await call('GET', '/api/status')).json;
    assert.equal(st.modules.length, 6);
    assert.ok(st.stats.sent24h > 5);
    ok('estado general');

    console.log(`\n✅ ${passed} comprobaciones superadas`);
    cdn.close();
    server.close();
    scheduler.stop();
    gameServers.stop();
    fakeMc.close();
    fakeSpark.close();
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ FALLO:', err);
    process.exit(1);
});
