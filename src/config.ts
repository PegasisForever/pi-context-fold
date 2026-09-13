import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { NAME, NUDGE_GROWTH_TOKENS } from "./nudge.ts";

/**
 * Our settings live under our own name in Pi's `settings.json`, the file `pi-powerline-footer`
 * already uses, rather than in a file of our own (§13). Global first, then the project's, shallow
 * merged so the project wins — the order Pi's own `SettingsManager` uses. Pi re-reads this file and
 * spreads it before every write it makes (`core/settings-manager.js:381`), so a key it does not know
 * about survives a theme change.
 */
export interface Config {
	nudgeGrowthTokens: number;
}

/**
 * Read at load, never in a handler. Pi drops an extension whose factory throws and says so
 * (`core/extensions/loader.js:483`), where it swallows a throw from a handler and carries on — which
 * would leave a session running on a default it was told it had changed.
 */
export function readConfig(cwd: string): Config {
	const merged: Record<string, unknown> = {};
	for (const path of [join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json")]) {
		Object.assign(merged, section(path));
	}
	const growth = merged.nudgeGrowthTokens ?? NUDGE_GROWTH_TOKENS;
	// The unknown key is named. A schema checker says "must not have additional properties" and never
	// says which one, and the name is the only part you need to fix a typo (C7).
	const unknown = Object.keys(merged).filter((key) => key !== "nudgeGrowthTokens");
	if (unknown.length > 0)
		throw new Error(
			`settings.json: "${NAME}" has no key "${unknown[0]}". The only key is nudgeGrowthTokens.`,
		);
	if (typeof growth !== "number" || !Number.isInteger(growth) || growth < 1000)
		throw new Error(
			`settings.json: "${NAME}".nudgeGrowthTokens must be a whole number of at least 1000.`,
		);
	return { nudgeGrowthTokens: growth };
}

/** Our object out of one settings file. A file that is not there is not an error; one that is there
 * and is broken is, because Pi cannot read it either and you have to fix it anyway. */
function section(path: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`${path}: the file must hold a JSON object.`);
	const ours = (parsed as Record<string, unknown>)[NAME];
	if (ours === undefined) return {};
	if (ours === null || typeof ours !== "object" || Array.isArray(ours))
		throw new Error(`${path}: "${NAME}" must be a JSON object.`);
	return ours as Record<string, unknown>;
}
