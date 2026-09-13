import { appendFileSync } from "node:fs";
import type { Config } from "./config";

/** One JSON line per record (§17, row 19.30): no levels, no rotation. A failed write throws where it
 * is called and nothing substitutes a value for it (C10); `debug` gates the per-round records. */
export function log(config: Config, event: string, data: Record<string, unknown>): void {
	appendFileSync(config.logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
}

export function logDebug(config: Config, event: string, data: Record<string, unknown>): void {
	if (config.debug) log(config, event, data);
}
