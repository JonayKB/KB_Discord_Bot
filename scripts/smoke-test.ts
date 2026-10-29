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
    MOJANG_API_URL: 'http://127.0.0.1:38211', MOJANG_SESSION_URL: 'http://127.0.0.1:38211',
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
    const { ServersService, WhitelistService, createServersModule } = await import(src('modules/servers'));
    const { ReactionRolesService, createReactionsModule } = await import(src('modules/reactions'));
    const { WelcomeService, createWelcomeModule } = await import(src('modules/welcome'));
    const { ModerationService, createModerationModule } = await import(src('modules/moderation'));
    const { TicketsService, createTicketsModule } = await import(src('modules/tickets'));
    const { startFakeMinecraft, startFakeSpark, startFakeRcon, startFakeMojang } = await import('./fake-game-servers');
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
    mock.addChannel('C_LOG', 'registro');
    mock.addChannel('CAT1', 'Soporte', ChannelType.GuildCategory);
    mock.addRole('R_SUP', 'Soporte');

    // ── Servicios (igual que index.ts) ──
    const db = openDb();
    const manager = new ModuleManager(client, db);
    const messages = new MessagesService(client, db);
    const confirmations = new ConfirmationService(client, db, messages);
    const inbox = new InboxService(db, messages);
    const scheduler = new SchedulerService(db, messages, confirmations);
    const gameServers = new ServersService(client, db, confirmations);
    const whitelist = new WhitelistService(client, db, gameServers, confirmations);
    const reactions = new ReactionRolesService(client, db);
    const welcome = new WelcomeService(client, db, messages);
    const moderation = new ModerationService(client, db, messages);
    const tickets = new TicketsService(client, db, messages);
    setServices({ messages, confirmations, servers: gameServers, reactions });
    manager.register(createMessagesModule(messages, db));
    manager.register(createInboxModule(inbox, messages, db));
    manager.register(createSchedulerModule(scheduler));
    manager.register(createConfirmationsModule(confirmations));
    manager.register(createServersModule(gameServers, whitelist));
    manager.register(createReactionsModule(reactions));
    manager.register(createWelcomeModule(welcome));
    manager.register(createModerationModule(moderation));
    manager.register(createTicketsModule(tickets));
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

    const edits0r = counterEdits.length;
    assert.ok(!counterEdits.some((o: any) => o.embeds?.[0]?.data?.title === 'Elige tus roles'), 'recién creado, no se edita (sin "(editado)")');
    assert.deepEqual((await call('POST', `/api/reactions/${P.id}/sync`)).json.warnings, []);
    await call('PUT', `/api/reactions/${P.id}`, P);
    assert.equal(counterEdits.length, edits0r, 'sincronizar o guardar sin cambios no edita');
    await call('PUT', `/api/reactions/${P.id}`, { ...P, description: 'Texto nuevo' });
    assert.equal(counterEdits.length, edits0r + 1, 'si cambia el texto, sí se edita');
    await call('PUT', `/api/reactions/${P.id}`, P);
    ok('el mensaje solo se edita cuando cambia (no aparece "(editado)" sin motivo)');

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

    console.log('\nHistorial de servidores (gráficas)');
    assert.equal((await call('GET', `/api/servers/${mcId}/history?range=2h`)).status, 400);
    const srvHist = (await call('GET', `/api/servers/${mcId}/history?range=1h`)).json;
    assert.ok(srvHist.points.length >= 1, 'cada consulta deja una muestra');
    assert.equal(srvHist.summary.peakPlayers, 2);
    assert.equal(srvHist.summary.uptime, 1);
    assert.ok(srvHist.points[0].tps > 0 && srvHist.points[0].players === 2);
    assert.ok(srvHist.bucketMs >= 1000);
    ok('las consultas se guardan y se agrupan por rango (jugadores, TPS, uptime)');

    console.log('\nBienvenida');
    const wcfg = (await call('GET', '/api/welcome')).json;
    assert.equal(wcfg.dm.enabled, true);
    assert.equal(wcfg.dm.payload.embed.title, '✨ ¡Bienvenido!', 'por defecto, la bienvenida de siempre');
    assert.equal((await call('PUT', '/api/welcome', { ...wcfg, channel: { ...wcfg.channel, enabled: true, channelId: null } })).status, 400);
    const saved = await call('PUT', '/api/welcome', {
        ...wcfg,
        channel: { enabled: true, channelId: 'C1', payload: { content: 'Hola {mention}, somos {count}' } },
        goodbye: { enabled: true, channelId: 'C1', payload: { content: 'Adiós {username}' } },
        autoRoleIds: ['R_A'],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const joiner = mock.addMember('U9', 'nuevo_dc');
    const sentW = sent.length;
    client.emit('guildMemberAdd', joiner);
    await sleep(200);
    assert.ok(sent.slice(sentW).some((m: any) => m.to === 'U9' && m.opts.embeds?.[0]?.data?.title === '✨ ¡Bienvenido!'), 'MD de bienvenida');
    assert.ok(channelsSent.some((o: any) => o.content === `Hola <@U9>, somos ${members.size}`), 'mensaje en el canal con {mention} y {count}');
    assert.ok(joiner.roles.cache.has('R_A'), 'rol automático');
    members.delete('U9');
    client.emit('guildMemberRemove', joiner);
    await sleep(100);
    assert.ok(channelsSent.some((o: any) => o.content === 'Adiós nuevo_dc'));
    ok('MD + mensaje en canal + rol automático al entrar, y despedida al salir');
    assert.equal((await call('POST', '/api/welcome/test', { kind: 'dm', config: saved.json })).status, 400, 'el usuario del panel no está en el servidor');
    ok('probar el mensaje exige estar en el servidor');

    console.log('\nModeración');
    const TROLL = '20000000000000001';
    const troll = mock.addMember(TROLL, 'troll_dc');
    const mcfg = (await call('GET', '/api/moderation/config')).json;
    assert.equal((await call('PUT', '/api/moderation/config', { ...mcfg, logChannelId: 'C_LOG', ignoreChannelIds: ['C_COUNT'] })).json.logChannelId, 'C_LOG');
    const lastLog = () => channelsSent.at(-1)?.embeds?.[0]?.data;

    assert.equal((await call('POST', '/api/moderation/actions', { action: 'warn', userId: TROLL, reason: '' })).status, 400);
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'warn', userId: 'U1', reason: 'x' })).status, 400);
    const warn = await call('POST', '/api/moderation/actions', { action: 'warn', userId: TROLL, reason: 'Spam en #general' });
    assert.equal(warn.status, 201);
    assert.equal(warn.json.dmStatus, 'sent');
    assert.equal(warn.json.moderatorName, 'Desarrollo');
    assert.ok(sent.some((m: any) => m.to === TROLL && /aviso/.test(m.opts.embeds?.[0]?.data?.title ?? '')), 'se avisa por MD');
    await sleep(50);
    assert.match(lastLog()?.title ?? '', /Aviso · caso #/);
    ok('avisar: motivo obligatorio, MD al usuario y publicado en el registro');

    const to = await call('POST', '/api/moderation/actions', { action: 'timeout', userId: TROLL, reason: 'Calma', durationMs: 600_000 });
    assert.equal(to.status, 201);
    assert.ok(mock.modLog.includes(`timeout:${TROLL}:600000`));
    const trollBefore = { ...troll, partial: false, communicationDisabledUntilTimestamp: null, roles: troll.roles, nickname: null };
    client.emit('guildMemberUpdate', trollBefore, troll);
    await sleep(50);
    assert.equal((await call('GET', `/api/moderation/cases?userId=${TROLL}&action=timeout`)).json.length, 1, 'el evento de Discord no duplica el caso');
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'timeout', userId: TROLL, reason: 'x', durationMs: 1000 })).status, 400);
    ok('silenciar con duración (sin duplicar el caso)');

    const manual = mock.addMember('20000000000000002', 'otro_dc');
    const manualBefore = { ...manual, partial: false, roles: manual.roles };
    manual.communicationDisabledUntilTimestamp = Date.now() + 3600_000;
    client.emit('guildMemberUpdate', manualBefore, manual);
    await sleep(50);
    const manualCases = (await call('GET', '/api/moderation/cases?userId=20000000000000002')).json;
    assert.equal(manualCases.length, 1);
    assert.equal(manualCases[0].source, 'discord');
    ok('un silencio hecho a mano en Discord también queda en el historial');

    troll.kickable = false;
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'kick', userId: TROLL, reason: 'x' })).status, 400);
    troll.kickable = true;
    const ban = await call('POST', '/api/moderation/actions', { action: 'ban', userId: TROLL, reason: 'Reincidente', deleteDays: 1 });
    assert.equal(ban.status, 201);
    assert.ok(mock.bans.has(TROLL) && !members.has(TROLL));
    assert.equal((await call('GET', '/api/moderation/bans')).json[0].userId, TROLL);
    client.emit('guildBanAdd', { user: troll.user, reason: 'x' });
    await sleep(50);
    assert.equal((await call('GET', `/api/moderation/cases?userId=${TROLL}&action=ban`)).json.length, 1, 'sin duplicar');
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'unban', userId: TROLL, reason: '' })).status, 201);
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'unban', userId: TROLL, reason: '' })).status, 400, 'ya no está baneado');
    const summary = (await call('GET', `/api/moderation/users/${TROLL}`)).json;
    assert.deepEqual(summary.counts, { warn: 1, timeout: 1, ban: 1, unban: 1 });
    ok('expulsar (comprueba permisos), banear, lista de baneos, desbanear e historial por usuario');

    const fakeMsg = (channelId: string, content: string) => ({ guildId: 'G1', channelId, partial: false, content, author: { id: 'U1', username: 'steve_dc', bot: false }, attachments: new Collection(), url: 'https://discord.com/x' });
    const n0 = channelsSent.length;
    client.emit('messageDelete', fakeMsg('C1', 'mensaje malo'));
    await sleep(50);
    assert.equal(lastLog()?.title, '🗑️ Mensaje borrado');
    assert.ok(lastLog().fields.some((f: any) => f.value === 'mensaje malo'));
    client.emit('messageDelete', fakeMsg('C_COUNT', 'ignorado'));
    client.emit('messageUpdate', fakeMsg('C1', 'igual'), fakeMsg('C1', 'igual'));
    await sleep(50);
    assert.equal(channelsSent.length, n0 + 1, 'canal ignorado y ediciones sin cambio de texto no se registran');
    client.emit('messageUpdate', fakeMsg('C1', 'antes'), fakeMsg('C1', 'después'));
    await sleep(50);
    assert.equal(lastLog()?.title, '✏️ Mensaje editado');
    ok('registro de mensajes borrados y editados');

    assert.equal((await call('DELETE', `/api/moderation/cases/${warn.json.id}`)).status, 200);
    await call('POST', '/api/modules/moderation/enabled', { enabled: false });
    const n1 = channelsSent.length;
    client.emit('messageDelete', fakeMsg('C1', 'nada'));
    await sleep(50);
    assert.equal(channelsSent.length, n1);
    assert.equal((await call('POST', '/api/moderation/actions', { action: 'warn', userId: '20000000000000002', reason: 'x' })).status, 409);
    await call('POST', '/api/modules/moderation/enabled', { enabled: true });
    ok('borrar un caso y desactivar el módulo en caliente');

    console.log('\nTickets');
    /** Simula pulsar un botón (o enviar un formulario si se pasa `modal`) en Discord. */
    const interact = (customId: string, userId: string, modal?: Record<string, string>) => {
        const log: any = { replies: [] as any[], modal: null };
        const i: any = {
            customId, user: members.get(userId).user, guild: mock.guild, deferred: false, replied: false,
            isButton: () => !modal, isModalSubmit: () => !!modal,
            fields: { getTextInputValue: (k: string) => { if (!modal || !(k in modal)) throw new Error('vacío'); return modal[k]; } },
            reply: async (o: any) => { i.replied = true; log.replies.push(o); },
            deferReply: async () => { i.deferred = true; },
            editReply: async (o: any) => { log.replies.push(o); },
            showModal: async (m: any) => { log.modal = m; },
            update: async (o: any) => { log.replies.push(o); },
            deferUpdate: async () => { i.deferred = true; },
        };
        client.emit('interactionCreate', i);
        return log;
    };
    const text = (r: any) => (typeof r === 'string' ? r : r?.content ?? '');
    const say = (channelId: string, userId: string, content: string) => client.emit('messageCreate', {
        id: `tm${Math.random()}`, guildId: 'G1', channelId, channel: { type: ChannelType.GuildText }, content, author: members.get(userId).user, member: members.get(userId),
        attachments: new Collection(), createdTimestamp: Date.now(),
    });

    await call('PUT', '/api/tickets/config', { logChannelId: 'C_LOG', deleteOnClose: true, closeDelaySec: 0, dmOnClose: true, attachTranscript: true });
    assert.equal((await call('POST', '/api/tickets/panels', { name: 'X', types: [{ label: 'A', categoryId: 'C1' }] })).status, 400, 'la categoría tiene que ser una categoría');
    const tp = await call('POST', '/api/tickets/panels', {
        name: 'Soporte', channelId: 'C1', title: 'Tickets', description: 'Pulsa un botón para abrir un ticket',
        types: [
            { label: 'Soporte', emoji: '🛠️', categoryId: 'CAT1', supportRoleIds: ['R_SUP'] },
            { label: 'Reportar', style: 'danger', questions: [{ label: '¿A quién reportas?' }, { label: 'Pruebas', long: true, required: false }] },
        ],
    });
    assert.equal(tp.status, 201, JSON.stringify(tp.json));
    const [tSup, tRep] = tp.json.panel.types;
    const panelMsg = channelsSent.at(-1);
    assert.equal(panelMsg.embeds[0].data.title, 'Tickets');
    assert.deepEqual(panelMsg.components[0].components.map((b: any) => b.data.custom_id), [`tk:open:${tSup.id}`, `tk:open:${tRep.id}`]);
    ok('crear y publicar el panel con un botón por tipo de ticket');
    const edits0t = counterEdits.length;
    await call('PUT', `/api/tickets/panels/${tp.json.panel.id}`, tp.json.panel);
    assert.equal(counterEdits.length, edits0t, 'guardar el panel sin cambios no lo edita');
    await call('PUT', `/api/tickets/panels/${tp.json.panel.id}`, { ...tp.json.panel, title: 'Soporte MCKB' });
    assert.equal(counterEdits.length, edits0t + 1);
    ok('el panel de tickets solo se edita cuando cambia');

    let r = interact(`tk:open:${tSup.id}`, 'U1');
    await sleep(80);
    const createdLog = mock.channelLog.find((l: string) => l.startsWith('create:'))!;
    assert.match(createdLog, /^create:TC\d+:ticket-0001$/);
    const tc1 = createdLog.split(':')[1];
    assert.match(text(r.replies.at(-1)), new RegExp(`<#${tc1}>`));
    const ow = mock.channels.get(tc1).overwrites;
    assert.ok(ow.some((o: any) => o.id === 'G1' && o.deny) && ow.some((o: any) => o.id === 'U1') && ow.some((o: any) => o.id === 'R_SUP'));
    assert.equal(mock.channels.get(tc1).parentId, 'CAT1');
    const opening = channelsSent.at(-1);
    assert.equal(opening.channelId, tc1);
    assert.match(opening.content, /<@U1> <@&R_SUP>/);
    assert.deepEqual(opening.components[0].components.map((b: any) => b.data.label), ['Cerrar', 'Cerrar con motivo', 'Atender']);
    ok('pulsar el botón crea un canal privado (usuario + soporte) en la categoría, con el mensaje inicial');

    r = interact(`tk:open:${tSup.id}`, 'U1');
    await sleep(50);
    assert.match(text(r.replies.at(-1)), /Ya tienes un ticket abierto/);
    ok('límite de tickets abiertos por usuario');

    r = interact(`tk:open:${tRep.id}`, 'U2');
    await sleep(20);
    assert.equal(r.modal.data.title, 'Reportar');
    assert.equal(r.modal.components.length, 2);
    interact(`tk:form:${tRep.id}`, 'U2', { q0: 'Un tal Pepe' });
    await sleep(80);
    let list = (await call('GET', '/api/tickets?status=open')).json;
    assert.equal(list.counts.open, 2);
    const repT = list.tickets.find((t: any) => t.typeLabel === 'Reportar');
    assert.deepEqual(repT.answers, [{ question: '¿A quién reportas?', answer: 'Un tal Pepe' }, { question: 'Pruebas', answer: '' }]);
    ok('tipo con formulario: las respuestas se guardan y aparecen en el ticket');

    const sup = list.tickets.find((t: any) => t.typeLabel === 'Soporte');
    say(tc1, 'U1', 'Necesito ayuda <script>');
    await sleep(30);
    assert.equal((await call('GET', `/api/tickets/${sup.id}`)).json.ticket.lastKind, 'user', 'queda "esperando respuesta"');
    assert.equal((await call('GET', '/api/tickets')).json.counts.waiting >= 1, true);
    const rep1 = await call('POST', `/api/tickets/${sup.id}/reply`, { content: 'Hola, ¿qué te pasa?' });
    assert.equal(rep1.status, 201);
    assert.equal(channelsSent.at(-1).content, '**Desarrollo:** Hola, ¿qué te pasa?');
    const detail = (await call('GET', `/api/tickets/${sup.id}`)).json;
    assert.deepEqual(detail.messages.map((m: any) => m.kind), ['system', 'user', 'panel']);
    assert.equal(detail.ticket.lastKind, 'panel');
    assert.equal((await call('POST', `/api/tickets/${sup.id}/reply`, { content: '  ' })).status, 400);
    ok('los mensajes del canal se guardan y se puede responder desde el panel');

    r = interact(`tk:claim:${sup.id}`, 'U3');
    await sleep(30);
    assert.match(text(r.replies.at(-1)), /Solo quien abrió el ticket o el staff/);
    members.get('U2').roles.cache.set('R_SUP', { id: 'R_SUP' });
    interact(`tk:claim:${sup.id}`, 'U2');
    await sleep(50);
    assert.equal((await call('GET', `/api/tickets/${sup.id}`)).json.ticket.claimedById, 'U2');
    ok('"Atender" solo para el staff (rol de soporte)');

    r = interact(`tk:close:${sup.id}`, 'U1');
    await sleep(20);
    assert.equal(r.replies[0].components[0].components[0].data.custom_id, `tk:closeok:${sup.id}`, 'pide confirmación');
    const sentT = sent.length;
    interact(`tk:closereason:${sup.id}`, 'U1', { reason: 'Ya está resuelto' });
    await sleep(150);
    const closed = (await call('GET', `/api/tickets/${sup.id}`)).json.ticket;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.closeReason, 'Ya está resuelto');
    const closeDm = sent.slice(sentT).find((m: any) => m.to === 'U1');
    assert.match(closeDm.opts.embeds[0].data.title, /Tu ticket #0001 se ha cerrado/);
    assert.equal(closeDm.opts.files.length, 1, 'transcripción adjunta');
    assert.ok(channelsSent.some((o: any) => o.channelId === 'C_LOG' && /Ticket #0001 cerrado/.test(o.embeds?.[0]?.data?.title ?? '')));
    assert.ok(mock.channelLog.includes(`delete:${tc1}`));
    assert.equal((await call('GET', `/api/tickets/${sup.id}`)).json.ticket.closeReason, 'Ya está resuelto', 'el borrado del propio bot no lo cambia');
    ok('cerrar con motivo: aviso en el canal, MD con transcripción, registro y borrado del canal');

    const tr = await fetch(`${base}/api/tickets/${sup.id}/transcript`, { headers: { cookie, 'x-requested-with': 'kb-panel' } });
    const transcript = await tr.text();
    assert.match(tr.headers.get('content-disposition') ?? '', /ticket-0001\.html/);
    assert.ok(transcript.includes('Necesito ayuda &lt;script&gt;') && transcript.includes('Ya está resuelto'));
    ok('descargar la transcripción (HTML escapado)');

    await call('PUT', '/api/tickets/config', { logChannelId: null, deleteOnClose: false, closeDelaySec: 0, dmOnClose: false, attachTranscript: false });
    const c2 = await call('POST', `/api/tickets/${repT.id}/close`, {});
    assert.equal(c2.status, 200);
    assert.equal(c2.json.closeReason, null);
    assert.ok(mock.channelLog.some((l: string) => l.startsWith(`rename:${repT.channelId}:cerrado-0002`)), 'sin borrar: se renombra');
    assert.ok(mock.channelLog.some((l: string) => l.startsWith(`perm:${repT.channelId}:U2:`)), 'y el usuario ya no puede escribir');
    assert.equal((await call('POST', `/api/tickets/${repT.id}/close`, {})).status, 400);
    ok('cerrar sin motivo desde el panel (y bloquear el canal en vez de borrarlo)');

    interact(`tk:open:${tSup.id}`, 'U1');
    await sleep(80);
    const t3 = (await call('GET', '/api/tickets?status=open')).json.tickets[0];
    assert.equal(t3.number, 3);
    assert.equal((await call('DELETE', `/api/tickets/${t3.id}`)).status, 400, 'no se borra uno abierto');
    await (await client.channels.fetch(t3.channelId)).delete();
    await sleep(50);
    const t3c = (await call('GET', `/api/tickets/${t3.id}`)).json.ticket;
    assert.equal(t3c.status, 'closed');
    assert.match(t3c.closeReason, /borró a mano/);
    assert.equal((await call('DELETE', `/api/tickets/${t3.id}`)).status, 200);
    assert.equal((await call('GET', '/api/tickets?q=Reportar')).json.tickets.length, 1, 'búsqueda');
    ok('borrar el canal a mano lo cierra; borrar del historial; búsqueda');

    console.log('\nRCON y whitelist');
    const ACCOUNTS: Record<string, string> = { Steve: 'aaa1', Alex: 'aaa2', Notch: 'aaa3', AdminManual: 'aaa4', NewName: 'aaa5', Jeb_: 'aaa6' };
    const mcState = { whitelist: ['AdminManual'], log: [] as string[], known: (n: string) => Object.keys(ACCOUNTS).some(a => a.toLowerCase() === n.toLowerCase()) };
    const fakeRcon = startFakeRcon(38210, 'secret', mcState);
    const fakeMojang = startFakeMojang(38211, ACCOUNTS);
    const wl = (n: string) => mcState.whitelist.some(x => x.toLowerCase() === n.toLowerCase());

    assert.equal((await call('POST', `/api/servers/${mcId}/rcon/test`)).status, 400, 'sin configurar');
    await call('PUT', `/api/servers/${mcId}/rcon`, { port: 38210, password: 'mala' });
    assert.match((await call('POST', `/api/servers/${mcId}/rcon/test`)).json.error, /incorrecta/);
    await call('PUT', `/api/servers/${mcId}/rcon`, { port: 38210, password: 'secret' });
    assert.equal((await call('POST', `/api/servers/${mcId}/rcon/test`)).json.ok, true);
    await call('PUT', `/api/servers/${mcId}/rcon`, { port: 38210 }); // sin contraseña: se conserva
    const svJson = JSON.stringify((await call('GET', '/api/servers')).json);
    assert.ok(svJson.includes('"hasPassword":true') && !svJson.includes('secret'), 'la contraseña nunca sale hacia el panel');
    assert.match((await call('POST', `/api/servers/${mcId}/rcon/command`, { command: '/whitelist list' })).json.output, /AdminManual/);
    ok('configurar RCON (contraseña oculta), probar conexión y consola');

    const wc = (await call('POST', '/api/confirmations/campaigns', { name: 'Whitelist', title: 'Whitelist', description: 'Tu nombre de Minecraft' })).json;
    assert.equal((await call('PUT', `/api/servers/${mcId}/whitelist/settings`, { enabled: true })).status, 400, 'hace falta la campaña');
    await call('PUT', `/api/servers/${mcId}/whitelist/settings`, { enabled: true, campaignId: wc.id, onlineMode: true, allowRename: false, removeOnLeave: true });
    const wlForm = async (userId: string, answer: string) => {
        const notes: string[] = [];
        try { await confirmations.respond(wc.id, userId, 'confirmed', { answer }, { notes }); return { notes }; }
        catch (err) { return { error: (err as Error).message }; }
    };
    const entryOf = (userId: string) => confirmations.getEntry(wc.id, userId);

    let f = await wlForm('U1', 'steve');
    assert.deepEqual(f.notes, ['✅ Estás en la whitelist de **Minecraft** como `Steve`.']);
    assert.ok(wl('Steve'));
    assert.equal(entryOf('U1').answer, 'Steve', 'se guarda con las mayúsculas reales de la cuenta');
    ok('al confirmar: se comprueba con Mojang, se añade por RCON y se le avisa');

    f = await wlForm('U2', 'STEVE');
    assert.match(f.error!, /ya lo tiene registrado otra persona/);
    assert.equal(entryOf('U2'), undefined, 'no se guarda la confirmación');
    assert.match((await wlForm('U2', 'Ghosty')).error!, /No existe ninguna cuenta/);
    assert.match((await wlForm('U2', 'Steve; op U2')).error!, /no es un nombre de Minecraft válido/);
    assert.ok(!mcState.log.some(c => c.includes(';')), 'nada raro llega a la consola');
    ok('no se repiten nombres; nombres inexistentes o con comandos colados se rechazan');

    assert.match((await wlForm('U1', 'Alex')).error!, /Ya tienes registrado "Steve"/);
    assert.ok(wl('Steve') && !wl('Alex'));
    await call('PUT', `/api/servers/${mcId}/whitelist/settings`, { enabled: true, campaignId: wc.id, allowRename: true, renameCooldownDays: 0 });
    f = await wlForm('U1', 'alex');
    assert.ok(wl('Alex') && !wl('Steve'), 'cambio de nombre: el viejo sale y entra el nuevo');
    const rem = mcState.log.indexOf('whitelist remove Steve');
    assert.ok(rem >= 0 && rem < mcState.log.indexOf('whitelist add Alex'), 'primero se quita el viejo');
    await call('PUT', `/api/servers/${mcId}/whitelist/settings`, { enabled: true, campaignId: wc.id, allowRename: true, renameCooldownDays: 30 });
    assert.match((await wlForm('U1', 'Notch')).error!, /cada 30 días/);
    ok('un nombre por persona: cambiarlo está bloqueado o limitado por tiempo, y nunca tiene dos');

    f = await wlForm('U3', 'AdminManual');
    let wlEntries = (await call('GET', `/api/servers/${mcId}/whitelist`)).json.entries;
    assert.equal(wlEntries.find((e: any) => e.mcName === 'AdminManual').preexisting, true);
    const u3 = members.get('U3');
    members.delete('U3');
    client.emit('guildMemberRemove', u3);
    await sleep(150);
    assert.ok(wl('AdminManual'), 'un nombre que ya estaba antes nunca lo quita el bot');
    assert.ok(!mcState.log.includes('whitelist remove AdminManual'));
    ok('nombres que ya estaban en la whitelist se respetan');

    await call('PUT', `/api/servers/${mcId}/rcon`, { port: 38299 });
    f = await wlForm('U2', 'notch');
    assert.match(f.notes![0], /en cuanto el servidor esté disponible/);
    wlEntries = (await call('GET', `/api/servers/${mcId}/whitelist`)).json.entries;
    const pend = wlEntries.find((e: any) => e.mcName === 'Notch');
    assert.equal(pend.status, 'pending_add');
    assert.match(pend.error, /rechazada/);
    assert.match((await wlForm('U4', 'Notch')).error!, /otra persona/, 'mientras está pendiente, el nombre también está reservado');
    await call('PUT', `/api/servers/${mcId}/rcon`, { port: 38210 });
    await sleep(100);
    await call('POST', `/api/servers/${mcId}/whitelist/process`);
    assert.ok(wl('Notch'));
    ok('servidor apagado: queda en cola (y reservado) y se aplica al volver');

    await confirmations.respond(wc.id, 'U2', 'denied', { reason: 'no puedo' });
    await sleep(100);
    assert.ok(!wl('Notch'), 'al decir que no participa sale de la whitelist');
    ok('pasar a "no participa" lo quita');

    const pa = await call('POST', `/api/servers/${mcId}/whitelist`, { userId: 'U1', name: 'newname' });
    assert.equal(pa.status, 201, JSON.stringify(pa.json));
    assert.equal(pa.json.status, 'active');
    assert.ok(wl('NewName') && !wl('Alex'));
    assert.equal(entryOf('U1').answer, 'NewName', 'la respuesta de la campaña se actualiza');
    assert.equal((await call('POST', `/api/servers/${mcId}/whitelist`, { userId: 'U2', name: 'NewName' })).status, 400, 'el staff tampoco puede duplicar');
    ok('el staff puede cambiar el nombre desde el panel (sin duplicar)');

    await confirmations.removeEntries(wc.id, ['U1'], { removeRole: false, resetNickname: false });
    await sleep(100);
    assert.ok(!wl('NewName'), 'borrarle de la campaña lo quita');
    confirmations.upsertEntry(wc.id, { userId: 'U4', username: 'done_dc', answer: 'jeb_', status: 'confirmed' });
    confirmations.upsertEntry(wc.id, { userId: 'U2', username: 'alex_dc', answer: 'JEB_', status: 'confirmed' });
    const imp = (await call('POST', `/api/servers/${mcId}/whitelist/import`)).json;
    assert.equal(imp.added, 1);
    assert.deepEqual(imp.skipped.map((x: any) => x.user).sort(), ['done_dc', 'newbie_dc'], 'gana quien confirmó antes; se salta el repetido y a quien ya salió del Discord');
    assert.ok(wl('Jeb_'));
    ok('importar confirmados existentes (saltando duplicados)');

    const serverView = (await call('GET', `/api/servers/${mcId}/whitelist/server`)).json;
    assert.deepEqual(serverView.map((x: any) => [x.name, !!x.userId]), [['AdminManual', false], ['Jeb_', true]]);
    assert.throws(() => db.prepare("INSERT INTO whitelist_entries (server_id, user_id, mc_name, status, created_at, updated_at) VALUES (?, 'X9', 'jeb_', 'active', 0, 0)").run(mcId), /UNIQUE/);
    ok('vista de la whitelist real y garantía en la base de datos');
    fakeRcon.close();
    fakeMojang.close();

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
    assert.equal(st.modules.length, 9);
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
