import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	nudgeGrowthTokens: number;
	logFile: string;
	debug: boolean;
}

const FILE = join(".pi", "context-fold.json");
const KEYS = ["nudgeGrowthTokens", "logFile", "debug"];

export const DEFAULTS: Config = {
	nudgeGrowthTokens: 200_000,
	logFile: join(homedir(), ".pi", "context-fold.log"),
	debug: false,
};

/**
 * §13: home, then the project on top, read once. Three string comparisons rather than allowlist
 * machinery. A missing file is the normal case; an unknown key and a malformed file are mistakes,
 * and a silent typo is a quiet wrong answer (C7).
 */
export function loadConfig(cwd: string): Config {
	const config = { ...DEFAULTS };
	for (const file of [join(homedir(), FILE), join(cwd, FILE)]) {
		if (!existsSync(file)) continue;
		for (const [key, value] of Object.entries(parse(file))) {
			if (key === "nudgeGrowthTokens" && typeof value === "number") config.nudgeGrowthTokens = value;
			else if (key === "logFile" && typeof value === "string") config.logFile = value;
			else if (key === "logFile" && value === null) config.logFile = DEFAULTS.logFile;
			else if (key === "debug" && typeof value === "boolean") config.debug = value;
			else if (KEYS.includes(key)) throw new Error(`"${key}" is ${JSON.stringify(value)} in ${file}, which that key does not take.`);
			else throw new Error(`unknown key "${key}" in ${file}. The keys are ${KEYS.join(", ")}.`);
		}
	}
	return config;
}

function parse(file: string): Record<string, unknown> {
	const text = readFileSync(file, "utf8");
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}
