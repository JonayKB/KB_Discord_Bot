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
fs.writeFileSync(path.join(tmp, 'data', 'config.json'), JSON.stringify({ rolContadoID: 'R_OK', canalID: 'C_COUNT', mensajeID: 'M_COUNT' }));
process.chdir(tmp);

const PORT = 38123;
Object.assign(process.env, {
    TOKEN: 'x', CLIENT_ID: '1', GUILD_ID: 'G1', ADMIN_ID: 'ADMIN', PANEL_PORT: String(PORT), PANEL_URL: `http://127.0.0.1:${PORT}`,
    PANEL_DEV_AUTH: '1', NODE_ENV: 'test', PANEL_HOST: '127.0.0.1',
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
    const { startWebServer } = await import(src('web/server'));
    const { migrateLegacy } = await import(src('core/migrateLegacy'));
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

    // ── Servicios (igual que index.ts) ──
    const db = openDb();
    const manager = new ModuleManager(client, db);
    const messages = new MessagesService(client, db);
    const confirmations = new ConfirmationService(client, db, messages);
    const inbox = new InboxService(db, messages);
    const scheduler = new SchedulerService(db, messages, confirmations);
    setServices({ messages, confirmations });
    manager.register(createMessagesModule(messages, db));
    manager.register(createInboxModule(inbox, messages, db));
    manager.register(createSchedulerModule(scheduler));
    manager.register(createConfirmationsModule(confirmations));
    migrateLegacy(db);
    migrateLegacy(db); // idempotente
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
    assert.equal(st.modules.length, 4);
    assert.ok(st.stats.sent24h > 5);
    ok('estado general');

    console.log(`\n✅ ${passed} comprobaciones superadas`);
    cdn.close();
    server.close();
    scheduler.stop();
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌ FALLO:', err);
    process.exit(1);
});
