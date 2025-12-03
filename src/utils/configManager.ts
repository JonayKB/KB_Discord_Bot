import type { ConfigData } from "../types/configData.ts";

import fs from 'fs';
import path from 'path';


const file = path.join(process.cwd(),'data', 'config.json');

export function loadConfig() {
    if (!fs.existsSync(file)) return { reactions: [] };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveConfig(data: ConfigData) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
