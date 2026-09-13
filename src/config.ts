import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const CONFIG_NAME = "context-fold.json";

/** `logFile: null` is the documented way to ask for the default back on top of a home setting. */
const ConfigSchema = Type.Object(
	{
		nudgeGrowthTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		logFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		debug: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export interface Config {
	nudgeGrowthTokens: number;
	logFile: string;
	debug: boolean;
}

export const DEFAULTS: Config = {
	nudgeGrowthTokens: 200_000,
	logFile: join(getAgentDir(), "context-fold.log"),
	debug: false,
};

/**
 * §13: the agent directory, then the project on top, read once. A missing file is the normal case;
 * an unknown key and a malformed file are mistakes, and a silent typo is a quiet wrong answer (C7).
 */
export function loadConfig(cwd: string): Config {
	const merged: Record<string, unknown> = {};
	const sources: string[] = [];
	for (const path of [join(getAgentDir(), CONFIG_NAME), join(cwd, CONFIG_DIR_NAME, CONFIG_NAME)]) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		sources.push(path);
		Object.assign(merged, parse(path, raw));
	}
	const wrong = problem(merged);
	if (wrong !== undefined) throw new Error(`${sources.join(" + ")}: ${wrong}`);
	const config = { ...DEFAULTS };
	if (typeof merged.nudgeGrowthTokens === "number") config.nudgeGrowthTokens = merged.nudgeGrowthTokens;
	if (typeof merged.logFile === "string") config.logFile = merged.logFile;
	if (typeof merged.debug === "boolean") config.debug = merged.debug;
	return config;
}

/**
 * What is wrong with a config file, in one sentence, or undefined when nothing is (C7). A schema
 * checker on its own says "must not have additional properties" and never names the key, which is
 * the one thing you need to fix a typo, so the unknown key is found here instead.
 */
function problem(value: Record<string, unknown>): string | undefined {
	const allowed = Object.keys(ConfigSchema.properties);
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown !== undefined) return `unknown key "${unknown}". The keys are ${allowed.join(", ")}.`;
	const error = [...Value.Errors(ConfigSchema, value)][0];
	if (error === undefined) return undefined;
	const path = error.instancePath.split("/").filter((step) => step !== "");
	if (path.length === 0) return error.message;
	let at: unknown = value;
	for (const step of path) at = (at as Record<string, unknown> | undefined)?.[step];
	return `"${path.join(".")}" is ${JSON.stringify(at)}, which that key does not take.`;
}

function parse(path: string, text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
