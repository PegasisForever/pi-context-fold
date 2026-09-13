import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * One JSON line per record: no levels, no rotation, no switch. A failed write throws where it is
 * called and nothing substitutes a value for it (C10). Read on every call, so the test suite's
 * `HOME` is honoured and a record never lands in the real agent directory.
 */
export function log(event: string, data: Record<string, unknown>): void {
	const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
	appendFileSync(join(getAgentDir(), "context-fold.log"), `${line}\n`);
}
