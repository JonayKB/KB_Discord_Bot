import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export default function compressOldLogs() {
  const logDir = path.resolve("logs");
  const filesToCompress = ["out.log", "error.log"];

  if (!fs.existsSync(logDir)) return;

  for (const file of filesToCompress) {
    const filePath = path.join(logDir, file);
    if (!fs.existsSync(filePath)) continue;
    const stats = fs.statSync(filePath);
    const modified = stats.mtime;
    const dateStr = modified
      .toISOString()
      .replaceAll(/[:.]/g, "-"); 
    const outputName = `${file}.${dateStr}.gz`;
    const outputPath = path.join(logDir, outputName);
    const size = stats.size;
    if (size === 0) continue;
    const data = fs.readFileSync(filePath);
    const compressed = zlib.gzipSync(data);
    fs.writeFileSync(outputPath, compressed);
    fs.writeFileSync(filePath, "");
  }
}