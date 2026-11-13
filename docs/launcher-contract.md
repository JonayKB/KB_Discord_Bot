# Contrato: servidores de juego → KB MC Launcher

Versión del contrato: **1**

El launcher muestra en la pantalla de cada modpack el estado de su servidor y las estadísticas del jugador. Lo lee de estas dos rutas **públicas** (sin sesión), servidas por el panel en la misma URL que las noticias (`https://discord.jonaykb.com`). El código está en `src/modules/servers/launcher.ts`.

## Qué se publica

Solo los servidores de **Minecraft**, **activos** y con **dirección pública** (`publicAddress`), que ya se enseña a todos en el mensaje de estado de Discord. Sin dirección pública, el servidor no aparece y su ficha de jugador da 404.

Nunca se publica el Discord de nadie: ni IDs ni nombres de usuario. De los jugadores solo sale su nombre de Minecraft.

Con el módulo «Servidores de juego» desactivado, las dos rutas responden `503`.

## 1. Estado: `GET /servers/status.json`

```json
{
  "version": 1,
  "updatedAt": "2026-11-13T18:00:00.000Z",
  "servers": [
    {
      "id": 1,
      "name": "Terramity",
      "address": "minecraft.jonaykb.com",
      "online": true,
      "checkedAt": "2026-11-13T17:59:40.000Z",
      "playersOnline": 12,
      "maxPlayers": 50,
      "players": ["Steve", "Alex"],
      "playerListComplete": false,
      "tps": 19.9,
      "mapUrl": "https://mapa.jonaykb.com/",
      "inviteUrl": "https://discord.gg/2V4GSxzEgZ",
      "opensAt": null
    }
  ]
}
```

- El launcher relaciona cada modpack con su servidor por la dirección: `server_address` del modpack en `index.json` == `address` (sin distinguir mayúsculas; sin puerto equivale a `:25565`).
- `players` puede ser una muestra (`playerListComplete: false`): el número real es `playersOnline`.
- `tps`: media del último minuto (Spark-REST), o `null` si el servidor no tiene la API de métricas.
- `checkedAt` es `null` si el bot aún no ha consultado el servidor desde que arrancó.
- `Cache-Control: no-cache`. El bot consulta cada servidor según su intervalo; el launcher pide el fichero cada minuto mientras está en la pantalla del modpack.

## 2. Jugador: `GET /servers/{id}/players/{nombre}`

`id` es el de `status.json`. `nombre` es el nombre de Minecraft (URL-encoded): primero se busca exacto y, si no hay, sin distinguir mayúsculas siempre que solo haya uno.

```json
{
  "version": 1,
  "name": "Steve",
  "updatedAt": "2026-11-13T17:55:00.000Z",
  "total":  { "playTimeSeconds": 5400, "deaths": 3, "mobKills": 25, "distanceCm": 250000, "advancements": 3 },
  "weekly": { "playTimeSeconds": 1800, "deaths": 1, "mobKills": 15, "distanceCm": 0, "advancements": 0 },
  "rank": {
    "total":  { "playTimeSeconds": 2, "deaths": 1, "mobKills": 1, "distanceCm": 1, "advancements": 1 },
    "weekly": { "playTimeSeconds": 1, "deaths": 1, "mobKills": 1, "distanceCm": null, "advancements": null }
  },
  "rankedPlayers": { "total": 14, "weekly": 6 }
}
```

- Las estadísticas son las del contrato del mod (`kb_discord_auth/docs/stats-contract.md`). Una que falte no se ha recibido nunca, no es 0.
- `rank`: puesto en el ranking (1 = primero) con los mismos filtros que el primer ranking activo de ese servidor en Discord (`linkedOnly`, `exclude`). `null` si no entra: valor 0 o jugador excluido.
- `rankedPlayers`: cuántos jugadores entran en el ranking de cada periodo (el máximo entre estadísticas).
- Errores: `404` (servidor no público o jugador sin datos), `400` (nombre no válido), `429` (más de 30 peticiones por minuto e IP).

## Cambios

El launcher rechaza un `version` distinto de 1. Para cambiar el formato de forma incompatible, sube `LAUNCHER_FORMAT_VERSION` y publica a la vez una versión del launcher que lo entienda. Añadir campos nuevos no rompe nada: el launcher ignora lo que no conoce.
