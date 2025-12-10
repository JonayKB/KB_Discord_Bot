import fs from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  private readonly logDir = path.resolve("logs");
  private readonly outFile = path.join(this.logDir, "out.log");
  private readonly errorFile = path.join(this.logDir, "error.log");

  constructor(private readonly scope?: string) {
    this.ensureLogFiles();
  }

  private ensureLogFiles() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir);
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

  error(msg: unknown, err?: Error): void {
    const fullMessage = err ? `${msg} | ${err.stack || err.message}` : msg;
    this.print("error", fullMessage);
  }
}
