import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
	getConfigStartupWarning,
	isConfigSyncFailed,
	isIntegerInRange,
	loadConfig,
	mergeConfigInputs,
	normalizeConfigData,
	parseConfigInput,
	parseModelSpec,
	setEnabledInConfig,
	resolveSuggestionModel,
	type PromptSuggestionsConfig,
} from "./config.ts";
import {
	buildSuggestionContext,
	candidatePoolSize,
	dedupeSuggestions,
	extractAssistantText,
	extractMessageText,
	formatMessageForSuggestion,
	generateSuggestions,
	getMessageRole,
	loadSuggestionSystemPrompt,
	normalizeSuggestionText,
	parseSuggestionArray,
	sanitizeSuggestion,
} from "./suggestions.ts";
import { debug, truncatePlain } from "./utils.ts";

const WIDGET_KEY = "next-prompt-suggestions";
const WIDGET_GENERATING_KEY = "prompt-buffet-generating";

let suggestions: string[] | undefined;
let generationId = 0;
let lastCtx: ExtensionContext | undefined;
let currentConfig: PromptSuggestionsConfig = loadConfig();
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
			if (isConfigSyncFailed()) {
				// Config-file I/O is disabled for the session after a startup
				// failure, so the toggle applies to in-memory state only.
				currentConfig = { ...currentConfig, enabled: arg === "on" };
			} else {
				setEnabledInConfig(arg === "on");
				currentConfig = loadConfig((message) => debug(ctx, message));
			}

			if (ctx.hasUI)
				ctx.ui.notify(
					`Prompt suggestions ${arg === "on" ? "enabled" : "disabled"} (applies from the next turn)`,
					"info",
				);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (isConfigSyncFailed()) {
			// Surface the startup failure above the editor, the same way a
			// startup warning diagnostic renders.
			const warning = getConfigStartupWarning();
			if (warning) ctx.ui.notify(warning, "warning");
		} else {
			currentConfig = loadConfig((message) => debug(ctx, message));
		}
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

	pi.on("agent_end", (event, ctx) => {
		lastCtx = ctx;
		clearSuggestion(ctx);

		if (ctx.mode !== "tui") return debug(ctx, `skipped: mode is ${ctx.mode}`);

		const config = isConfigSyncFailed()
			? currentConfig
			: loadConfig((message) => debug(ctx, message));
		if (!config.enabled) return debug(ctx, "skipped: disabled by config");
		if (ctx.hasPendingMessages()) return debug(ctx, "skipped: pending messages");
		if (ctx.ui.getEditorText().trim().length > 0) return debug(ctx, "skipped: editor is not empty");

		const model = resolveSuggestionModel(ctx, config.model);
		if (!model) return debug(ctx, "skipped: no model selected");

		const id = ++generationId;
		debug(ctx, "generating...");
		showGeneratingIndicator(ctx);

		// Fire and forget. Pi awaits agent_end handlers before settling the turn; blocking here
		// on the suggestion request keeps the "Working..." indicator animating and re-rendering
		// the whole TUI (which also defeats terminal scrollback) long after the agent finished.
		void (async () => {
			try {
				const raw = await generateSuggestions(event.messages, ctx, model, config);
				debug(ctx, `raw: ${JSON.stringify(truncatePlain(JSON.stringify(raw), 320))}`);
				if (id !== generationId) return debug(ctx, "ignored: stale result");
				if (ctx.hasPendingMessages()) {
					clearGeneratingIndicator(id, ctx);
					return debug(ctx, "ignored: pending messages appeared");
				}
				if (ctx.ui.getEditorText().trim().length > 0) {
					clearGeneratingIndicator(id, ctx);
					return debug(ctx, "ignored: editor became non-empty");
				}

				// Model ranks candidates by confidence; sanitize, drop near-duplicates, then keep the top maxSuggestions.
				const clean = dedupeSuggestions(
					raw
						.map((text) => sanitizeSuggestion(text, config.maxChars))
						.filter((text): text is string => text !== undefined),
				).slice(0, config.maxSuggestions);
				if (!clean.length) {
					clearGeneratingIndicator(id, ctx);
					return debug(ctx, `rejected: ${JSON.stringify(truncatePlain(JSON.stringify(raw), 320))}`);
				}

				// Hide the "Generating..." line right before the options appear below the editor.
				clearGeneratingIndicator(id, ctx);
				showSuggestions(clean, ctx);
				debug(ctx, `shown: ${JSON.stringify(clean)}`);
			} catch (error) {
				clearGeneratingIndicator(id, ctx);
				debug(ctx, `error: ${error instanceof Error ? error.message : String(error)}`);
				// Suggestion generation is best-effort and must never interrupt normal use.
			}
		})();
	});
}

function clearSuggestion(ctx = lastCtx): void {
	generationId++;
	suggestions = undefined;
	clearGeneratingIndicator(undefined, ctx);
	ctx?.ui.setWidget(WIDGET_KEY, undefined);
}

function showSuggestions(items: string[], ctx = lastCtx): void {
	clearSuggestion(ctx);
	suggestions = items;
	renderSuggestions(ctx);
}

function renderSuggestions(ctx = lastCtx): void {
	if (!ctx || !suggestions) return;
	if (!isConfigSyncFailed()) currentConfig = loadConfig((message) => debug(ctx, message));
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

// Show the transient "Generating..." line above the editor.
// Rendered as a static widget: setWidget triggers a single redraw, and the
// component is otherwise inert (no timer, no animated frames, no-op
// invalidate), so its mere presence never drives a redraw loop and does not
// interfere with terminal scrollback.
function showGeneratingIndicator(ctx = lastCtx): void {
	ctx?.ui.setWidget(
		WIDGET_GENERATING_KEY,
		(_tui, theme) => ({
			// Indent by outputPad (default 1) so the line lines up with the chat text,
			// which is left-padded by the same setting. The extension API does not
			// expose the configured value, so the default pad is used.
			render: (width: number) => [truncateToWidth(` ${theme.fg("dim", "Generating suggestions...")}`, width)],
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

// Hide the transient "Generating..." line. Pass the generation id from an async
// path so a stale result (whose generation was superseded) never wipes a newer
// indicator; a plain call from a synchronous reset clears unconditionally.
function clearGeneratingIndicator(id?: number, ctx = lastCtx): void {
	if (id !== undefined && id !== generationId) return;
	ctx?.ui.setWidget(WIDGET_GENERATING_KEY, undefined);
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

export const __test__ = {
	buildSuggestionContext,
	isIntegerInRange,
	mergeConfigInputs,
	normalizeConfigData,
	parseConfigInput,
	parseModelSpec,
	candidatePoolSize,
	dedupeSuggestions,
	extractAssistantText,
	extractMessageText,
	formatMessageForSuggestion,
	getMessageRole,
	loadSuggestionSystemPrompt,
	normalizeSuggestionText,
	parseSuggestionArray,
	sanitizeSuggestion,
	truncatePlain,
};
