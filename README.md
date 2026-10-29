# KB Discord Bot

Bot de Discord de MCKBServers, ahora **modular** y con un **panel web** para gestionarlo todo sin tocar código ni reiniciar.

## Qué ha cambiado

| Antes | Ahora |
|---|---|
| El cron de las 14:00 estaba fijo en `index.ts` | Módulo **Programación**: pausar, cambiar la frecuencia, ejecutar al momento, "cada 3 días", días de la semana, una sola vez… todo en caliente |
| No se veían los mensajes | Módulo **Mensajes** + **Historial**: todo lo enviado y recibido queda guardado y se puede buscar/filtrar |
| No se podía responder fuera de Discord | Módulo **Bandeja**: conversaciones por MD, responder desde el panel (texto + imágenes) |
| No se enviaban imágenes | Texto, embeds e **imágenes/archivos** a un usuario, varios, un rol, todo el servidor o un canal; plantillas reutilizables y variables (`{user}`, `{server}`…) |
| Una sola confirmación, y borrar a alguien era editar JSON | Módulo **Confirmaciones**: **varias campañas a la vez** (cada una con su formulario, roles, contador y calendario), borrar/añadir/corregir confirmados desde el panel |
| Estado de un solo servidor, configurado en el `.env` | Módulo **Servidores de juego**: varios servidores de Minecraft y Hytale, estadísticas en directo en el panel (jugadores, latencia, TPS, MSPT, CPU, versión) y su mensaje de estado en Discord, todo editable sin reiniciar |
| `/setreaction`: un emoji → un rol, guardado en `config.json` | Módulo **Roles por reacción**: varios emojis y roles por mensaje, cada uno con su comportamiento (normal, permanente, quitar rol, invertido o pulsar), modo exclusivo (un solo rol a la vez), publicar mensajes nuevos o usar uno que ya existe, todo editable desde el panel |
| Bienvenida por MD escrita en el código | Módulo **Bienvenida**: MD, mensaje en un canal y despedida editables desde el panel (con vista previa y botón de prueba), roles automáticos al entrar |
| — | Módulo **Moderación**: canal de registro (mensajes borrados/editados, entradas, salidas, roles, apodos, silencios, baneos) y avisar / silenciar / expulsar / banear desde el panel con historial por usuario |
| Solo el estado actual del servidor de juego | **Estadísticas** de cada servidor: gráficas de jugadores, TPS, MSPT, CPU, latencia y disponibilidad (1 h a 30 días) |
| Whitelist a mano | **RCON** en cada servidor de Minecraft: consola desde el panel y whitelist automática a partir de una campaña de confirmación (un nombre por persona, sin repetidos, comprobado con Mojang, con cola si el servidor está apagado y sin tocar nunca los nombres añadidos a mano) |
| — | Módulo **Tickets**: panel con botones (un tipo de ticket por botón, con formulario opcional) que crea un canal privado en una categoría con el staff; desde el panel se responden, se atienden, se cierran con o sin motivo y queda el historial con transcripción |
| Todo mezclado | Cada función es un módulo independiente que se activa/desactiva al instante |

## Puesta en marcha

Requisitos: Node 20+ (probado con 22).

```bash
cp .env.example .env      # rellena TOKEN, CLIENT_ID, GUILD_ID, ADMIN_ID y lo del panel
npm install
npm run build             # compila el bot y el panel
npm run start             # pm2 (o `npm run deploy` para actualizar)
```

El flujo de despliegue de GitHub Actions no cambia: hace `git pull`, `npm i` y `npm run deploy` (que ahora también compila el panel).

### Login con Discord (OAuth2)

1. [Developer Portal](https://discord.com/developers/applications) → tu aplicación → **OAuth2**.
2. Copia el **Client Secret** a `DISCORD_CLIENT_SECRET` en el `.env`.
3. En **Redirects** añade `<PANEL_URL>/auth/callback` (p. ej. `http://localhost:3000/auth/callback`).
4. Entra en `PANEL_URL`. Solo pasan los IDs de `PANEL_ADMIN_IDS` (por defecto `ADMIN_ID`) y, opcionalmente, quien tenga un rol de `PANEL_ROLE_IDS`.

### ¿Cómo accedo al panel desde fuera del servidor?

Por defecto escucha solo en `127.0.0.1:3000`. Opciones:

- **Túnel SSH** (lo más simple): `ssh -p 6454 -L 3000:localhost:3000 usuario@servidor` y abres `http://localhost:3000`.
- **Dominio con nginx/Caddy** y HTTPS: pon `PANEL_URL=https://panel.tudominio.com` y haz proxy a `127.0.0.1:3000` **incluyendo WebSocket** (`/ws`):
  ```nginx
  location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      client_max_body_size 25m;
  }
  ```

## Primer arranque: migración automática

Al arrancar por primera vez, el bot convierte tu configuración antigua (sin borrar nada):

- `config.json` + los IDs que estaban en el código → una campaña **"Confirmación Minecraft"** (rol de confirmado, rol de rechazo, roles excluidos y mensaje contador).
- `names.json` y `denied_reasons.json` → confirmados y rechazos de esa campaña (se enlazan a su ID real de Discord en cuanto la persona está en el servidor; si ya no está aparece como "No encontrado").
- El cron fijo de las 14:00 → una tarea editable **"Envío diario de la confirmación"**.
- Los botones de los MD que ya enviaste **siguen funcionando**.
- `SERVER_TYPE` + `MINECRAFT_*` / `HYTALE_*` del `.env` y el mensaje de estado de `config.json` → un servidor en **Servidores de juego** (después esas variables ya no se usan).
- Los roles por reacción de `config.json` (`/setreaction`) → **Roles por reacción**, uno por mensaje y con el comportamiento de siempre (reaccionar da el rol, quitar la reacción lo quita). Nadie pierde sus roles y los mensajes siguen funcionando igual.

## Estructura

```
src/
  index.ts                 arranque: BD, módulos, panel y código "clásico"
  core/                    base común
    module.ts              gestor de módulos (activar/desactivar en caliente)
    db.ts                  SQLite + migraciones (data/bot.db)
    bus.ts / logs.ts       eventos y logs en tiempo real hacia el panel
    migrateLegacy.ts       importa la configuración antigua (una vez)
  modules/
    messages/              enviar, historial, plantillas
    inbox/                 MD recibidos y respuestas
    scheduler/             tareas programadas
    confirmations/         campañas, formularios, confirmados, contador
    servers/               servidores de juego: consulta (MC/Hytale), estado en el panel y mensaje en Discord
  web/                     servidor del panel (Express + WebSocket) y login con Discord
  commands/ events/ utils/ código anterior: bienvenida, /create_info_message, /setreaction
web/                       panel (React + Vite)
scripts/                   smoke-test.ts, demo-panel.ts, fake-game-servers.ts
```

### Cómo añadir un módulo nuevo

Un módulo es un objeto con `id`, `name`, `start(ctx)`, opcionalmente `stop()` y un `router` de Express:

```ts
export function createMiModulo(): BotModule {
    const router = Router();
    router.get('/algo', (_req, res) => res.json({ ok: true }));   // → GET /api/mi-modulo/algo

    return {
        id: 'mi-modulo', name: 'Mi módulo', description: 'Hace cosas',
        router,
        start(ctx) {
            ctx.listen('messageCreate', msg => { /* ... */ });   // se elimina solo al desactivar
            ctx.every(60_000, () => { /* ... */ });              // idem
        },
    };
}
```
Regístralo en `src/index.ts` con `manager.register(createMiModulo())` y aparecerá en **Módulos** con su interruptor. Los `GET` de su router funcionan siempre; el resto devuelve 409 si el módulo está desactivado.

## Desarrollo

```bash
npm run dev          # bot con recarga
npm run dev:web      # panel con recarga (http://localhost:5173, proxy al bot en :3000)
npm run demo         # panel con un Discord SIMULADO y datos de ejemplo (http://localhost:3100) – no necesita token
npm run smoke        # 28 pruebas automáticas de los flujos principales con Discord simulado
```

## Notas y cambios de comportamiento

- **Módulo Mensajes desactivado = pausa global**: el bot no envía nada (ni programado ni confirmaciones) hasta reactivarlo.
- **Envíos masivos**: 1 MD por segundo aprox. para respetar los rate limits; el progreso se ve en directo.
- La bandeja solo lista conversaciones "reales" (alguien te escribió, o tú le escribiste/respondiste a un usuario); los MD automáticos y masivos quedan en el Historial.
- El comando `/create_confirmation_message` ya no existe: el mensaje contador se crea desde **Confirmaciones**. `/setreaction` sigue funcionando (ahora con una opción `modo`) y lo que crea aparece en **Roles por reacción**.
- `/create_info_message canal [servidor]` publica el mensaje de estado de un servidor de juego (por defecto el primero). Ahora solo lo ven quienes pueden **Gestionar el servidor**. Lo mismo se hace desde **Servidores**.
- **Campañas solo para un rol**: la opción "Enviar solo a quien tenga alguno de estos roles" limita los envíos (y el "Enviar al unirse") a quien tenga ese rol. Sirve para encuestas a los ya confirmados, p. ej. elegir modpack. Con "Respuesta larga" el formulario es un párrafo de hasta 1000 caracteres.
- **Servidores de juego**: en Minecraft, el estado y los jugadores salen del ping normal; con `enable-query=true` se ve la lista completa, y con el puerto de la API de métricas (Spark `/metrics`), TPS, MSPT y CPU. En Hytale se usa la API Nitrado Query. Los jugadores se asocian a Discord por lo que respondieron en las campañas.
- El formulario de confirmación al unirse ahora es la opción **"Enviar al unirse"** de cada campaña (la bienvenida sigue siendo automática y ahora queda en el historial).
- El contador usa la descripción del embed (límite 4096) en vez de un campo (límite 1024), así no se rompe con muchos confirmados.
- Se eliminó `NODE_TLS_REJECT_UNAUTHORIZED=0` global: desactivaba la verificación TLS de **todo** el proceso. Ahora solo se relaja en la petición al servidor de Hytale (certificado autofirmado).
- `node-cron` se sustituyó por `croner` (zonas horarias, vista previa de próximas ejecuciones y pausa/reanudación).
- Errores no capturados ya no tumban el bot, y hay apagado limpio con `pm2 reload`.
- Las imágenes recibidas se descargan a `data/uploads/` (los enlaces del CDN de Discord caducan).
