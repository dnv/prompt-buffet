import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function debug(ctx: ExtensionContext, message: string): void {
	if (process.env.PROMPT_BUFFET_DEBUG !== "1") return;
	ctx.ui.setStatus("next-suggestions", `suggestions: ${message}`);
	ctx.ui.notify(`next-suggestions: ${message}`, "info");
	try {
		appendFileSync(join(ctx.cwd, "prompt-buffet-debug.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Debug logging must not affect the extension.
	}
}

export function truncatePlain(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
