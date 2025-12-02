import type { Client } from "discord.js";

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (client: Client) => {
    const eventsPath = path.join(__dirname);
    const eventFolders = fs.readdirSync(eventsPath);

    for (const folder of eventFolders) {
        if (folder === 'index.ts') continue;

        const folderPath = path.join(eventsPath, folder);
        const eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.ts'));

        for (const file of eventFiles) {
            const event = await import(path.join(folderPath, file));

            client.on(event.default.name, (...args) => event.default.execute(client, ...args));

            console.info(`🗹 Loaded Event: ${event.default.name}`);
        }
    }
};
