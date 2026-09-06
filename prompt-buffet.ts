import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	convertToLlm,
	getAgentDir,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { completeSimple, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai/compat";
import { Key, matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

const WIDGET_KEY = "next-prompt-suggestions";
const DEFAULT_MAX_CHARS = 80;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_SUGGESTIONS = 3;
const GLOBAL_CONFIG_RELATIVE_PATH = ["extensions", "prompt-buffet.json"];
const PROMPT_RELATIVE_PATH = ["prompts", "suggestion-system-prompt.md"];
// Every key the extension currently reads, with its default value.
// Add new configurable settings here; they will be backfilled into
// existing config files on load, and removed from this list means removed from user files.
const CONFIG_DEFAULTS: Record<string, unknown> = {
	model: "default",
	enabled: true,
	maxChars: DEFAULT_MAX_CHARS,
	maxTokens: DEFAULT_MAX_TOKENS,
	maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
};
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

interface PromptSuggestionsConfig {
	enabled: boolean;
	maxChars: number;
	maxTokens: number;
	maxSuggestions: number;
	model?: string;
}

type PromptSuggestionsConfigInput = Partial<PromptSuggestionsConfig>;

let suggestions: string[] | undefined;
let generationId = 0;
let lastCtx: ExtensionContext | undefined;
let currentConfig: PromptSuggestionsConfig = mergeConfigInputs();
let currentEditor: SuggestionEditor | undefined;

class SuggestionEditor extends CustomEditor {
	requestRender(): void {
		this.tui.requestRender(true);
	}

	handleInput(data: string): void {
		if (this.getText().length === 0 && suggestions && suggestions.length > 0) {
			const digit = data.length === 1 ? Number(data) : 0;
			if (Number.isInteger(digit) && digit >= 1 && digit <= suggestions.length) {
				this.setText(suggestions[digit - 1]);
				clearSuggestion();
				return;
			}
		}

		if (suggestions && suggestions.length > 0 && isUserEditKey(data)) {
			clearSuggestion();
		}

		super.handleInput(data);
	}
}

export default function promptBuffet(pi: ExtensionAPI) {
	pi.registerCommand("prompt-buffet", {
		description: "Toggle prompt suggestions: /prompt-buffet on|off",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["on", "off"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Prompt suggestions: ${currentConfig.enabled ? "on" : "off"} — usage: /prompt-buffet on|off`,
						"info",
					);
				return;
			}
			setEnabledInConfig(arg === "on");
			currentConfig = loadConfig((message) => debug(ctx, message));
			if (ctx.hasUI)
				ctx.ui.notify(
					`Prompt suggestions ${arg === "on" ? "enabled" : "disabled"} (applies from the next turn)`,
					"info",
				);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		currentConfig = loadConfig((message) => debug(ctx, message));
		clearSuggestion(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			currentEditor = new SuggestionEditor(tui, theme, keybindings);
			return currentEditor;
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);
	});

	pi.on("input", (_event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearSuggestion(ctx);
		ctx.ui.setEditorComponent(undefined);
		currentEditor = undefined;
		lastCtx = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);

		if (ctx.mode !== "tui") return debug(ctx, `skipped: mode is ${ctx.mode}`);

		const config = loadConfig((message) => debug(ctx, message));
		if (!config.enabled) return debug(ctx, "skipped: disabled by config");
		if (ctx.hasPendingMessages()) return debug(ctx, "skipped: pending messages");
		if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "skipped: editor is not empty");

		const model = resolveSuggestionModel(ctx, config.model);
		if (!model) return debug(ctx, "skipped: no model selected");

		const id = ++generationId;
		debug(ctx, "generating...");

		try {
			const raw = await generateSuggestions(event.messages, ctx, model, config);
			debug(ctx, `raw: ${JSON.stringify(truncatePlain(JSON.stringify(raw), 320))}`);
			if (id !== generationId) return debug(ctx, "ignored: stale result");
			if (ctx.hasPendingMessages()) return debug(ctx, "ignored: pending messages appeared");
			if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "ignored: editor became non-empty");

			// Model ranks candidates by confidence; sanitize, drop near-duplicates, then keep the top maxSuggestions.
			const clean = dedupeSuggestions(
				raw
					.map((text) => sanitizeSuggestion(text, config.maxChars))
					.filter((text): text is string => text !== undefined),
			).slice(0, config.maxSuggestions);
			if (!clean.length) return debug(ctx, `rejected: ${JSON.stringify(truncatePlain(JSON.stringify(raw), 320))}`);

			showSuggestions(clean, ctx);
			debug(ctx, `shown: ${JSON.stringify(clean)}`);
		} catch (error) {
			debug(ctx, `error: ${error instanceof Error ? error.message : String(error)}`);
			// Suggestion generation is best-effort and must never interrupt normal use.
		}
	});
}

function clearSuggestion(ctx = lastCtx): void {
	generationId++;
	suggestions = undefined;
	ctx?.ui.setWidget(WIDGET_KEY, undefined);
}

function showSuggestions(items: string[], ctx = lastCtx): void {
	clearSuggestion(ctx);
	suggestions = items;
	renderSuggestions(ctx);
}

function renderSuggestions(ctx = lastCtx): void {
	if (!ctx || !suggestions) return;
	currentConfig = loadConfig((message) => debug(ctx, message));
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render: (width: number) => {
				const list = suggestions ?? [];
				return list.map((item, index) =>
					truncateToWidth(theme.fg("dim", `${index + 1}. ${item}`), width),
				);
			},
			invalidate: () => {},
		}),
		{ placement: "belowEditor" },
	);
}

async function generateSuggestions(
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

function parseSuggestionArray(text: string): string[] {
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

const SUGGESTION_POOL_MULTIPLIER = 2;

function candidatePoolSize(maxSuggestions: number): number {
	return Math.max(SUGGESTION_POOL_MULTIPLIER * maxSuggestions, 2);
}

function loadSuggestionSystemPrompt(
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
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "prompt-buffet.ts"))) return dir;
		dir = join(dir, "..");
	}
	return cwd;
}

const FALLBACK_SUGGESTION_SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]\n\nReply with a JSON array of up to {maxCandidates} short natural next prompts, ranked most to least likely, or [] if unclear.`;

function buildSuggestionContext(messages: Message[]): string {
	const recent = messages.slice(-8).map(formatMessageForSuggestion).filter(Boolean);
	return `Recent conversation from the just-finished agent turn:\n\n${recent.join("\n\n")}`;
}

function formatMessageForSuggestion(message: Message): string {
	const role = getMessageRole(message);
	const text = extractMessageText(message).trim();
	if (!text) return `${role}: [no text]`;
	return `${role}: ${truncatePlain(text, 2_000)}`;
}

function getMessageRole(message: unknown): string {
	if (isRecord(message) && typeof message.role === "string") return message.role;
	if (isRecord(message) && typeof message.type === "string") return message.type;
	return "message";
}

function extractMessageText(message: unknown): string {
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

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sanitizeSuggestion(text: string, maxChars = DEFAULT_MAX_CHARS): string | undefined {
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

function dedupeSuggestions(items: string[]): string[] {
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

function normalizeSuggestionText(text: string): string {
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

function isUserEditKey(data: string): boolean {
	if (data.length === 1 && data.charCodeAt(0) >= 32) return true;
	return (
		matchesKey(data, Key.backspace) ||
		matchesKey(data, Key.delete) ||
		matchesKey(data, Key.enter) ||
		matchesKey(data, Key.tab)
	);
}

function truncatePlain(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function loadConfig(onWarning?: (message: string) => void): PromptSuggestionsConfig {
	const globalPath = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	const config = mergeConfigInputs(readConfigFile(globalPath, onWarning));
	ensureConfigFile(globalPath, onWarning);
	return config;
}

function ensureConfigFile(path: string, onWarning?: (message: string) => void): void {
	if (existsSync(path)) return;
	try {
		writeFileSync(path, formatConfigFile(normalizeConfigData({})));
	} catch (error) {
		onWarning?.(`config creation failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function setEnabledInConfig(enabled: boolean): string {
	const path = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	let data: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			}
		} catch {
			// Corrupt file: rebuild from defaults rather than blocking the toggle
		}
	}
	data.enabled = enabled;
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
	return path;
}

function readConfigFile(path: string, onWarning?: (message: string) => void): PromptSuggestionsConfigInput {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		onWarning?.(`config ignored: ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	if (!isRecord(raw)) {
		onWarning?.(`config ignored: ${path}: expected object`);
		return {};
	}
	syncConfigFileKeys(path, raw, onWarning);
	return parseConfigInput(normalizeConfigData(raw), path, onWarning);
}

// Backfill defaults for supported keys that are missing from an older config file,
// and drop keys the extension no longer supports. Rewrites the file when it diverges.
function syncConfigFileKeys(path: string, raw: Record<string, unknown>, onWarning?: (message: string) => void): void {
	const normalized = normalizeConfigData(raw);
	const canonical = formatConfigFile(normalized);
	try {
		const current = readFileSync(path, "utf-8");
		if (current !== canonical) {
			writeFileSync(path, canonical);
			onWarning?.(`config resynced: ${path}`);
		}
	} catch (error) {
		onWarning?.(`config resync failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function normalizeConfigData(raw: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) normalized[key] = value;
	for (const [key, value] of Object.entries(raw)) {
		if (key in CONFIG_DEFAULTS) normalized[key] = value;
	}
	return normalized;
}

function formatConfigFile(data: Record<string, unknown>): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

function parseConfigInput(
	value: unknown,
	path = "config",
	onWarning?: (message: string) => void,
): PromptSuggestionsConfigInput {
	if (!isRecord(value)) {
		onWarning?.(`config ignored: ${path}: expected object`);
		return {};
	}

	const config: PromptSuggestionsConfigInput = {};
	if ("enabled" in value) {
		if (typeof value.enabled === "boolean") config.enabled = value.enabled;
		else onWarning?.(`config ignored: ${path}: enabled must be boolean`);
	}
	if ("model" in value) {
		if (value.model === "default") {
			// Explicit "unset"; use the session model.
		} else if (typeof value.model === "string" && value.model.trim()) config.model = value.model.trim();
		else onWarning?.(`config ignored: ${path}: model must be non-empty string`);
	}
	if ("maxChars" in value) {
		if (isPositiveInteger(value.maxChars)) config.maxChars = value.maxChars;
		else onWarning?.(`config ignored: ${path}: maxChars must be positive integer`);
	}
	if ("maxTokens" in value) {
		if (isPositiveInteger(value.maxTokens)) config.maxTokens = value.maxTokens;
		else onWarning?.(`config ignored: ${path}: maxTokens must be positive integer`);
	}
	if ("maxSuggestions" in value) {
		if (isIntegerInRange(value.maxSuggestions, 1, 6)) config.maxSuggestions = value.maxSuggestions;
		else onWarning?.(`config ignored: ${path}: maxSuggestions must be integer 1-6`);
	}
	return config;
}

function mergeConfigInputs(...configs: PromptSuggestionsConfigInput[]): PromptSuggestionsConfig {
	return {
		enabled: true,
		maxChars: DEFAULT_MAX_CHARS,
		maxTokens: DEFAULT_MAX_TOKENS,
		maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
		...Object.assign({}, ...configs),
	};
}

function resolveSuggestionModel(ctx: ExtensionContext, configuredModel: string | undefined): Model<any> | undefined {
	if (!configuredModel) return ctx.model;
	const parsed = parseModelSpec(configuredModel);
	if (!parsed) {
		debug(ctx, `configured model ignored: expected provider/model, got ${configuredModel}`);
		return ctx.model;
	}
	const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
	if (!model) {
		debug(ctx, `configured model not found: ${configuredModel}`);
		return ctx.model;
	}
	return model;
}

function parseModelSpec(spec: string): { provider: string; model: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function debug(ctx: ExtensionContext, message: string): void {
	if (process.env.PROMPT_BUFFET_DEBUG !== "1") return;
	ctx.ui.setStatus("next-suggestions", `suggestions: ${message}`);
	ctx.ui.notify(`next-suggestions: ${message}`, "info");
	try {
		appendFileSync(join(ctx.cwd, "prompt-buffet-debug.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Debug logging must not affect the extension.
	}
}

export const __test__ = {
	buildSuggestionContext,
	candidatePoolSize,
	dedupeSuggestions,
	extractAssistantText,
	extractMessageText,
	formatMessageForSuggestion,
	getMessageRole,
	isIntegerInRange,
	loadSuggestionSystemPrompt,
	mergeConfigInputs,
	normalizeConfigData,
	normalizeSuggestionText,
	parseConfigInput,
	parseModelSpec,
	parseSuggestionArray,
	sanitizeSuggestion,
	truncatePlain,
};
