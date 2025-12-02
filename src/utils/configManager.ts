import type { ConfigData } from "../types/configData.ts";

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const file = path.join(__dirname, '../data/config.json');

export function loadConfig() {
    if (!fs.existsSync(file)) return { reactions: [] };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveConfig(data: ConfigData) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
