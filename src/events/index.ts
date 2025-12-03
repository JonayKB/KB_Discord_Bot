import type { Client } from "discord.js";
import fs from 'fs';
import path from 'path';


export default async (client: Client) => {
  const eventsPath = path.join(__dirname);

  // Filtrar solo carpetas, ignorar archivos como index.ts o index.js
  const eventFolders = fs.readdirSync(eventsPath).filter(f =>
    fs.statSync(path.join(eventsPath, f)).isDirectory()
  );

  for (const folder of eventFolders) {
    const folderPath = path.join(eventsPath, folder);
    const eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js') || file.endsWith('.ts'));

    for (const file of eventFiles) {
      const { default: event } = await import(path.join(folderPath, file));

      if (!event || !event.name || !event.execute) {
        console.warn(`⚠️ Invalid event in file ${file}`);
        continue;
      }

      client.on(event.name, (...args) => event.execute(client, ...args));
      console.info(`🗹 Loaded Event: ${event.name}`);
    }
  }
};
