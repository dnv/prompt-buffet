import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
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
