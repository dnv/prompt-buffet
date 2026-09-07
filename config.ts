import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { debug, isRecord } from "./utils.ts";

export const DEFAULT_MAX_CHARS = 80;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_MAX_SUGGESTIONS = 3;
const GLOBAL_CONFIG_RELATIVE_PATH = ["extensions", "prompt-buffet.json"];

// Every key the extension currently reads, with its default value.
// Add new configurable settings here; they will be backfilled into
// existing config files on load, and removed from this list means removed from user files.
export const CONFIG_DEFAULTS: Record<string, unknown> = {
	model: "default",
	enabled: true,
	maxChars: DEFAULT_MAX_CHARS,
	maxTokens: DEFAULT_MAX_TOKENS,
	maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
};

export interface PromptSuggestionsConfig {
	enabled: boolean;
	maxChars: number;
	maxTokens: number;
	maxSuggestions: number;
	model?: string;
}

export type PromptSuggestionsConfigInput = Partial<PromptSuggestionsConfig>;

export function loadConfig(onWarning?: (message: string) => void): PromptSuggestionsConfig {
	const globalPath = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	const config = mergeConfigInputs(readConfigFile(globalPath, onWarning));
	ensureConfigFile(globalPath, onWarning);
	return config;
}

function ensureConfigFile(path: string, onWarning?: (message: string) => void): void {
	if (existsSync(path)) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, formatConfigFile(normalizeConfigData({})));
	} catch (error) {
		onWarning?.(`config creation failed: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function setEnabledInConfig(enabled: boolean): string {
	const path = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	let data: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (isRecord(parsed)) {
				data = parsed;
			}
		} catch {
			// Corrupt file: rebuild from defaults rather than blocking the toggle
		}
	}
	data.enabled = enabled;
	mkdirSync(dirname(path), { recursive: true });
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

export function normalizeConfigData(raw: Record<string, unknown>): Record<string, unknown> {
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

export function parseConfigInput(
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

export function mergeConfigInputs(...configs: PromptSuggestionsConfigInput[]): PromptSuggestionsConfig {
	return {
		enabled: true,
		maxChars: DEFAULT_MAX_CHARS,
		maxTokens: DEFAULT_MAX_TOKENS,
		maxSuggestions: DEFAULT_MAX_SUGGESTIONS,
		...Object.assign({}, ...configs),
	};
}

export function resolveSuggestionModel(ctx: ExtensionContext, configuredModel: string | undefined): Model<any> | undefined {
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

export function parseModelSpec(spec: string): { provider: string; model: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

