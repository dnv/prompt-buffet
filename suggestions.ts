import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convertToLlm, type AgentEndEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_MAX_CHARS, type PromptSuggestionsConfig } from "./config.ts";
import { debug, isRecord, truncatePlain } from "./utils.ts";

const PROMPT_RELATIVE_PATH = ["prompts", "suggestion-system-prompt.md"];

const ALLOWED_SINGLE_WORD_SUGGESTIONS = new Set([
	"yes",
	"yeah",
	"yep",
	"yea",
	"yup",
	"sure",
	"ok",
	"okay",
	"push",
	"commit",
	"deploy",
	"stop",
	"continue",
	"check",
	"exit",
	"quit",
	"no",
]);

const SUGGESTION_POOL_MULTIPLIER = 2;

export function candidatePoolSize(maxSuggestions: number): number {
	return Math.max(SUGGESTION_POOL_MULTIPLIER * maxSuggestions, 2);
}

export async function generateSuggestions(
	messages: AgentEndEvent["messages"],
	ctx: ExtensionContext,
	model: Model<any>,
	config: PromptSuggestionsConfig,
): Promise<string[]> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		debug(ctx, `auth unavailable: ${"error" in auth ? auth.error : "unknown error"}`);
		return [];
	}

	const llmMessages = convertToLlm(messages);
	const context = buildSuggestionContext(llmMessages);
	debug(ctx, `context: ${JSON.stringify(truncatePlain(context, 240))}`);
	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: config.maxTokens,
		reasoning: model.reasoning ? ("minimal" as const) : undefined,
	};

	const response = await completeSimple(
		model,
		{
			systemPrompt: loadSuggestionSystemPrompt(ctx.cwd, { maxChars: config.maxChars, maxCandidates: candidatePoolSize(config.maxSuggestions) }, (message) => debug(ctx, message)),
			messages: [
				{
					role: "user",
					content: context,
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	debug(
		ctx,
		`response: ${response.stopReason}; ${response.content.map((part) => part.type).join(",")}; ${response.errorMessage ?? ""}`,
	);
	if (response.diagnostics?.length) {
		debug(ctx, `diagnostics: ${JSON.stringify(response.diagnostics).slice(0, 500)}`);
	}

	const text = extractAssistantText(response);
	if (response.stopReason !== "stop" && !text) return [];
	const items = parseSuggestionArray(text);
	debug(ctx, `parsed: ${JSON.stringify(items)}`);
	return items;
}

export function parseSuggestionArray(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");

	if (start === -1) {
		// No array at all; a valid JSON object is treated as "no suggestions",
		// anything else is taken as a single plain-text suggestion.
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return [];
		} catch {
			// Not JSON; fall through to plain text.
		}
		return [trimmed];
	}

	const inner = trimmed.slice(start, end > start ? end + 1 : trimmed.length);
	if (end > start) {
		try {
			const parsed = JSON.parse(trimmed.slice(start, end + 1));
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean);
		} catch {
			// Malformed JSON; fall through to comma split.
		}
	}
	return inner
		.replace(/^\[/, "")
		.replace(/\]?$/, "")
		.split(",")
		.map((part) => part.trim().replace(/^["']+|["']+$/g, ""))
		.filter(Boolean);
}

export function loadSuggestionSystemPrompt(
	cwd: string,
	config: { maxChars: number; maxCandidates: number },
	onWarning?: (message: string) => void,
): string {
	const packagePromptPath = join(resolvePackageRoot(cwd), ...PROMPT_RELATIVE_PATH);
	let prompt: string;
	try {
		prompt = readFileSync(packagePromptPath, "utf-8").trim();
	} catch (error) {
		onWarning?.(`prompt load failed: ${packagePromptPath}: ${error instanceof Error ? error.message : String(error)}`);
		prompt = FALLBACK_SUGGESTION_SYSTEM_PROMPT;
	}
	return prompt
		.replaceAll("{maxChars}", String(config.maxChars))
		.replaceAll("{maxCandidates}", String(config.maxCandidates));
}

function resolvePackageRoot(cwd: string): string {
	let dir = import.meta.dirname;
	while (dir !== join(dir, "..")) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "index.ts"))) return dir;
		dir = join(dir, "..");
	}
	return cwd;
}

const FALLBACK_SUGGESTION_SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]\n\nReply with a JSON array of up to {maxCandidates} short natural next prompts, ranked most to least likely, or [] if unclear.`;

export function buildSuggestionContext(messages: Message[]): string {
	const recent = messages.slice(-8).map(formatMessageForSuggestion).filter(Boolean);
	return `Recent conversation from the just-finished agent turn:\n\n${recent.join("\n\n")}`;
}

export function formatMessageForSuggestion(message: Message): string {
	const role = getMessageRole(message);
	const text = extractMessageText(message).trim();
	if (!text) return `${role}: [no text]`;
	return `${role}: ${truncatePlain(text, 2_000)}`;
}

export function getMessageRole(message: unknown): string {
	if (isRecord(message) && typeof message.role === "string") return message.role;
	if (isRecord(message) && typeof message.type === "string") return message.type;
	return "message";
}

export function extractMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(message);
	return content
		.map((part) => {
			if (!isRecord(part) || typeof part.type !== "string") return "";
			if (part.type === "text" && typeof part.text === "string") return part.text;
			if (part.type === "thinking") return "";
			if (part.type === "toolCall" && typeof part.name === "string") return `[tool call: ${part.name}]`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

export function sanitizeSuggestion(text: string, maxChars = DEFAULT_MAX_CHARS): string | undefined {
	let clean = text.trim();
	if (!clean) return undefined;
	if (clean.includes("\n")) return undefined;

	clean = clean.replace(/^```(?:\w+)?\s*/, "").replace(/\s*```$/, "").trim();
	clean = clean.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
	clean = clean.replace(/\.$/, "").trim();

	if (!clean) return undefined;
	if (clean.length > maxChars) return undefined;
	if (/[\n*]|\*\*/.test(clean)) return undefined;
	if (/^[-•]\s/.test(clean)) return undefined;
	if (/^\w+:\s/.test(clean)) return undefined;
	if (/^\(.*\)$|^\[.*\]$/.test(clean)) return undefined;

	const lower = clean.toLowerCase();
	const wordCount = clean.split(/\s+/).length;
	if (lower === "done") return undefined;
	if (isMetaSuggestion(lower)) return undefined;
	if (isErrorSuggestion(lower)) return undefined;
	if (wordCount > 25) return undefined;
	if (wordCount < 2 && !isAllowedSingleWordSuggestion(lower, clean)) return undefined;
	if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)\b/i.test(clean)) return undefined;
	if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/i.test(clean)) return undefined;

	return capitalizeFirst(clean);
}

export function dedupeSuggestions(items: string[]): string[] {
	const kept: string[] = [];
	const keptWords: Set<string>[] = [];
	for (const item of items) {
		const norm = normalizeSuggestionText(item);
		if (!norm) continue;
		const words = new Set(norm.split(" ").filter(Boolean));
		const isDup = kept.some((other, index) => {
			const otherWords = keptWords[index];
			if (words.size === 0 || otherWords.size === 0) return norm === normalizeSuggestionText(other);
			return areSimilarSuggestions(words, otherWords);
		});
		if (isDup) continue;
		kept.push(item);
		keptWords.push(words);
	}
	return kept;
}

function areSimilarSuggestions(a: Set<string>, b: Set<string>): boolean {
	let intersection = 0;
	for (const word of a) if (b.has(word)) intersection++;
	if (intersection === 0) return false;
	const smaller = Math.min(a.size, b.size);
	const larger = Math.max(a.size, b.size);
	// One phrase contained in the other ("run the tests" vs "run the tests now"),
	// or overall near-identical wording.
	return intersection >= smaller || intersection >= 0.6 * larger;
}

export function normalizeSuggestionText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function capitalizeFirst(text: string): string {
	const first = text.search(/\S/);
	if (first === -1) return text;
	const ch = text[first];
	return text.slice(0, first) + ch.toUpperCase() + text.slice(first + 1);
}

function isMetaSuggestion(lower: string): boolean {
	return (
		lower === "nothing found" ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		lower === "[]" ||
		/\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
		/^\W*silence\W*$/.test(lower)
	);
}

function isErrorSuggestion(lower: string): boolean {
	return (
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key") ||
		lower.startsWith("image was too large")
	);
}

function isAllowedSingleWordSuggestion(lower: string, clean: string): boolean {
	if (clean.startsWith("/")) return true;
	return ALLOWED_SINGLE_WORD_SUGGESTIONS.has(lower);
}
