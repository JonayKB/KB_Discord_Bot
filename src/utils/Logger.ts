import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    ts: string;
    level: LogLevel;
    scope?: string;
    message: string;
}

const listeners = new Set<(entry: LogEntry) => void>();

/** Permite a otras partes (panel, buffer en memoria) recibir cada línea de log. */
export function onLog(fn: (entry: LogEntry) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export class Logger {
    private readonly logDir = path.resolve(__dirname, "../../logs");
    private readonly outFile = path.join(this.logDir, "out.log");
    private readonly errorFile = path.join(this.logDir, "error.log");

    constructor(private readonly scope?: string) {
        this.ensureLogFiles();
    }

    private ensureLogFiles() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        if (!fs.existsSync(this.outFile)) {
            fs.writeFileSync(this.outFile, "");
        }

        if (!fs.existsSync(this.errorFile)) {
            fs.writeFileSync(this.errorFile, "");
        }
    }

    private timestamp(): string {
        return new Date().toISOString();
    }

    private color(level: LogLevel, text: string): string {
        const colors: Record<LogLevel, string> = {
            debug: "\x1b[36m", // cyan
            info: "\x1b[32m",  // green
            warn: "\x1b[33m",  // yellow
            error: "\x1b[31m", // red
        };

        return `${colors[level]}${text}\x1b[0m`;
    }

    private format(level: LogLevel, msg: unknown): string {
        const timestamp = this.timestamp();
        const scope = this.scope ? ` [${this.scope}]` : "";
        const levelStr = level.toUpperCase();

        const base = `[${timestamp}] [${levelStr}]${scope} ${msg}`;
        return base;
    }

    private writeToFile(level: LogLevel, rawMsg: string) {
        if (level === "error") {
            fs.appendFileSync(this.errorFile, rawMsg + "\n");
        } else {
            fs.appendFileSync(this.outFile, rawMsg + "\n");
        }
    }

    private print(level: LogLevel, msg: unknown) {
        const raw = this.format(level, msg);
        const colored = this.color(level, raw);
        switch (level) {
            case "debug":
                console.debug(colored);
                break;
            case "info":
                console.info(colored);
                break;
            case "warn":
                console.warn(colored);
                break;
            case "error":
                console.error(colored);
                break;
        }
        this.writeToFile(level, raw);
        const entry: LogEntry = { ts: this.timestamp(), level, scope: this.scope, message: String(msg) };
        for (const fn of listeners) {
            try { fn(entry); } catch { /* un listener roto no debe tumbar el bot */ }
        }
    }

    debug(msg: unknown): void {
        this.print("debug", msg);
    }

    info(msg: unknown): void {
        this.print("info", msg);
    }

    warn(msg: unknown): void {
        this.print("warn", msg);
    }

    error(msg: unknown, err?: unknown): void {
        const detail = err instanceof Error ? (err.stack || err.message) : err !== undefined ? String(err) : "";
        const base = msg instanceof Error ? (msg.stack || msg.message) : msg;
        const fullMessage = detail ? `${base} | ${detail}` : base;
        this.print("error", fullMessage);
    }
}
