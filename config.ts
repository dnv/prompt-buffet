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

/**
 * Startup failure state. Once set, all filesystem I/O on the settings path is
 * skipped for the rest of the session and the extension operates on its
 * built-in defaults. The canonical warning is kept so the UI can render it.
 */
let configSyncFailed = false;
let configStartupWarning: string | undefined;

export function isConfigSyncFailed(): boolean {
	return configSyncFailed;
}

export function getConfigStartupWarning(): string | undefined {
	return configStartupWarning;
}

function markConfigSyncFailed(warning: string): void {
	if (configSyncFailed) return;
	configSyncFailed = true;
	configStartupWarning = warning;
}

export function loadConfig(onWarning?: (message: string) => void): PromptSuggestionsConfig {
	if (configSyncFailed) return mergeConfigInputs();

	const globalPath = join(getAgentDir(), ...GLOBAL_CONFIG_RELATIVE_PATH);
	const report = (message: string): void => onWarning?.(message);

	let existing: PromptSuggestionsConfigInput | undefined;
	try {
		existing = readConfigFile(globalPath, report);
	} catch (error) {
		// The directory exists, but the settings file could not be read or
		// resynced. Fall back to defaults and stop touching disk for the session.
		markConfigSyncFailed(
			"prompt-buffet: could not sync ~/.pi/agent/extensions/prompt-buffet.json settings, using defaults",
		);
		report(`config sync failed: ${globalPath}: ${describeError(error)}`);
		return mergeConfigInputs();
	}

	if (existing === undefined) {
		// First run: create the directory and seed the settings file.
		try {
			mkdirSync(dirname(globalPath), { recursive: true });
		} catch (error) {
			markConfigSyncFailed(
				"prompt-buffet: could not create ~/.pi/agent/extensions/ directory, using default settings",
			);
			report(`config creation failed: ${globalPath}: ${describeError(error)}`);
			return mergeConfigInputs();
		}
		try {
			writeFileSync(globalPath, formatConfigFile(normalizeConfigData({})));
		} catch (error) {
			// Directory exists, but seeding the missing settings failed.
			markConfigSyncFailed(
				"prompt-buffet: could not sync ~/.pi/agent/extensions/prompt-buffet.json settings, using defaults",
			);
			report(`config write failed: ${globalPath}: ${describeError(error)}`);
			return mergeConfigInputs();
		}
		return mergeConfigInputs();
	}

	return mergeConfigInputs(existing);
}

export function setEnabledInConfig(enabled: boolean): void {
	// After a startup sync failure the settings file is never read or written
	// again for the session; callers toggle their in-memory state instead.
	if (configSyncFailed) return;
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
}

// Returns undefined when the settings file does not exist yet (first run).
// Throws on any other read or resync failure so loadConfig can latch the
// extension into defaults-only mode.
function readConfigFile(path: string, report: (message: string) => void): PromptSuggestionsConfigInput | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		// ENOENT: the file does not exist yet (first run). ENOTDIR: a parent
		// path segment is not a directory, so the file cannot exist either.
		// Both delegate to loadConfig's directory-creation stage, which
		// classifies whether the failure is a directory-creation error.
		if (isErrorWithCode(error, "ENOENT") || isErrorWithCode(error, "ENOTDIR")) return undefined;
		throw error;
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid JSON: ${describeError(error)}`);
	}
	if (!isRecord(data)) throw new Error("expected a JSON object");

	syncConfigFileKeys(path, data, report);
	return parseConfigInput(normalizeConfigData(data), path, report);
}

// Backfill defaults for supported keys that are missing from an older config file,
// and drop keys the extension no longer supports. Rewrites the file when it diverges.
// Throws on read or write failure so the caller latches into defaults-only mode.
function syncConfigFileKeys(path: string, raw: Record<string, unknown>, report: (message: string) => void): void {
	const normalized = normalizeConfigData(raw);
	const canonical = formatConfigFile(normalized);
	const current = readFileSync(path, "utf-8");
	if (current !== canonical) {
		writeFileSync(path, canonical);
		report(`config resynced: ${path}`);
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrorWithCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

