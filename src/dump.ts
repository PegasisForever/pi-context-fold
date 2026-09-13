import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Msg } from "./types";

const CACHE = ".cache/pi/context-fold";

/**
 * The folded original, verbatim, one section per message (§6). This is what replaces the `recall`
 * tool: the model reads one block's file by the path on its summary, and greps the folder across
 * every block it has ever folded. Pi's own `serializeConversation` truncates tool results, so it
 * cannot be used here — the file has to match what left the view.
 */
export function writeOriginal(sessionId: string, blockId: string, messages: Msg[]): void {
	write(`${sessionId}/${blockId}.txt`, messages);
}

export function originalPath(sessionId: string, blockId: string): string {
	return `~/${CACHE}/${sessionId}/${blockId}.txt`;
}

/** The overflow dump (§8): the same format, so one reader serves both files. */
export function writeOverflow(sessionId: string, timestamp: number, messages: Msg[]): string {
	const relative = `overflow/${sessionId}-${timestamp}.txt`;
	write(relative, messages);
	return `~/${CACHE}/${relative}`;
}

function write(relative: string, messages: Msg[]): void {
	const path = join(homedir(), CACHE, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, messages.map(section).join("\n\n"), "utf8");
}

function section(message: Msg, index: number): string {
	const head = `=== ${index + 1} ${message.role}${label(message)} ===`;
	return `${head}\n${body(message)}`;
}

function label(message: Msg): string {
	if (message.role === "toolResult") return ` ${message.toolName}${message.isError ? " (error)" : ""}`;
	if (message.role === "custom") return ` ${message.customType}`;
	return "";
}

function body(message: Msg): string {
	if (message.role !== "assistant") return messageText(message);
	const parts = message.content.map((part) => {
		if (part.type === "text") return part.text;
		if (part.type === "thinking") return `[thinking] ${part.thinking}`;
		return `[toolCall ${part.name} ${part.id}] ${JSON.stringify(part.arguments)}`;
	});
	return parts.join("\n");
}

/** The plain text of a message: what it says, without tool calls or thinking. */
export function messageText(message: Msg): string {
	switch (message.role) {
		case "user":
		case "toolResult":
		case "custom":
			return typeof message.content === "string" ? message.content : textOf(message.content);
		case "assistant":
			return textOf(message.content);
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default: {
			const unreachable: never = message;
			throw new Error(`unhandled message role in ${JSON.stringify(unreachable)}`);
		}
	}
}

type TextPart = Extract<Extract<Msg, { role: "assistant" }>["content"][number], { type: "text" }>;

function textOf(content: { type: string }[]): string {
	return content
		.filter((part): part is TextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
