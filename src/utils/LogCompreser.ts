import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DAYS_TO_KEEP = 3;


export default function compressOldLogs() {
    const logDir = path.resolve("logs");
    const filesToCompress = ["out.log", "error.log"];

    if (!fs.existsSync(logDir)) return;

    for (const file of filesToCompress) {
        const filePath = path.join(logDir, file);
        if (!fs.existsSync(filePath)) continue;
        const stats = fs.statSync(filePath);
        const modified = stats.mtime;
        const dateStr = new Intl.DateTimeFormat("en-CA").format(modified);
        const outputName = `${file}.${dateStr}.gz`;
        const outputPath = path.join(logDir, outputName);
        const size = stats.size;
        if (size === 0) continue;
        const data = fs.readFileSync(filePath);
        const compressed = zlib.gzipSync(data);
        fs.writeFileSync(outputPath, compressed);
        fs.writeFileSync(filePath, "");
    }

    // Delete old logs
    const files = fs.readdirSync(logDir);
    const now = Date.now();
    for (const file of files) {
        if (!file.endsWith(".gz")) continue;
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        const created = stats.ctime;
        const ageInDays = (now - created.getTime()) / (1000 * 60 * 60 * 24);
        if (ageInDays > DAYS_TO_KEEP) {
            fs.unlinkSync(filePath);
        }

    }
}