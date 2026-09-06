import assert from "node:assert";
import { test } from "node:test";

const mod: any = await import("../prompt-buffet.ts");
const {
	buildSuggestionContext,
	candidatePoolSize,
	dedupeSuggestions,
	formatMessageForSuggestion,
	getMessageRole,
	isIntegerInRange,
	mergeConfigInputs,
	normalizeConfigData,
	parseConfigInput,
	parseModelSpec,
	parseSuggestionArray,
	sanitizeSuggestion,
	truncatePlain,
} = mod.__test__;

test("parseSuggestionArray parses a plain JSON array", () => {
	assert.deepStrictEqual(parseSuggestionArray('["commit this", "run the tests"]'), [
		"commit this",
		"run the tests",
	]);
});

test("parseSuggestionArray strips code fences and surrounding text", () => {
	const text = 'Here are the suggestions:\n\n```json\n["yes", "continue"]\n```\n';
	assert.deepStrictEqual(parseSuggestionArray(text), ["yes", "continue"]);
});

test("parseSuggestionArray treats bare text as a single suggestion", () => {
	assert.deepStrictEqual(parseSuggestionArray("run the tests"), ["run the tests"]);
});

test("parseSuggestionArray falls back to comma split for malformed JSON", () => {
	assert.deepStrictEqual(parseSuggestionArray('["commit this", "run the tests'), [
		"commit this",
		"run the tests",
	]);
});

test("parseSuggestionArray drops non-string items and returns [] for non-arrays", () => {
	assert.deepStrictEqual(
		parseSuggestionArray("[\"yes\", 42, \"continue\"]"),
		["yes", "continue"],
	);
	assert.deepStrictEqual(parseSuggestionArray("{}"), []);
	assert.deepStrictEqual(parseSuggestionArray(""), []);
});

test("sanitizeSuggestion accepts normal next prompts", () => {
	assert.strictEqual(sanitizeSuggestion("run the tests"), "Run the tests");
	assert.strictEqual(sanitizeSuggestion("commit this."), "Commit this");
	assert.strictEqual(sanitizeSuggestion("count to 20"), "Count to 20");
	assert.strictEqual(sanitizeSuggestion('  "try it out" '), "Try it out");
	assert.strictEqual(sanitizeSuggestion("/reload"), "/reload");
});

test("sanitizeSuggestion accepts questions and multi-sentence prompts up to 25 words", () => {
	assert.strictEqual(sanitizeSuggestion("is this ok?"), "Is this ok?");
	assert.strictEqual(sanitizeSuggestion("run the tests. Next, push the branch."), "Run the tests. Next, push the branch"); // trailing period is stripped
	assert.strictEqual(
		sanitizeSuggestion("commit this and run the tests and push and tag a release please"),
		"Commit this and run the tests and push and tag a release please",
	);
});

test("sanitizeSuggestion rejects prompts over 25 words", () => {
	assert.strictEqual(
		sanitizeSuggestion("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive"),
		undefined,
	);
});

test("sanitizeSuggestion accepts allowed single words", () => {
	assert.strictEqual(sanitizeSuggestion("yes"), "Yes");
	assert.strictEqual(sanitizeSuggestion("commit"), "Commit");
	assert.strictEqual(sanitizeSuggestion("maybe"), undefined);
	assert.strictEqual(sanitizeSuggestion("banana"), undefined);
});

test("sanitizeSuggestion rejects bad outputs", () => {
	const bad = [
		"",
		"  ",
		"no suggestion",
		"nothing to suggest",
		"[]",
		"silence",
		"api error: 401",
		"prompt is too long",
		"I'll run the tests now.",
		"Let me check the logs.",
		"Here's what we can do",
		"thanks for the help",
		"looks good",
		"line one\nline two",
		"- run the tests",
		"**commit this**",
		"Suggestion: commit this",
		"(silence)",
		"[no suggestion]",
	];
	for (const item of bad) {
		assert.strictEqual(sanitizeSuggestion(item), undefined, item);
	}
});

test("sanitizeSuggestion enforces maxChars", () => {
	const text = "any long suggestion here that exceeds fifty chars"; // 49 chars
	assert.strictEqual(sanitizeSuggestion(text), "Any long suggestion here that exceeds fifty chars");
	assert.strictEqual(sanitizeSuggestion(text, 48), undefined);
	assert.strictEqual(sanitizeSuggestion(text, 49), "Any long suggestion here that exceeds fifty chars");
});

test("formatMessageForSuggestion extracts text, tool calls, and roles", () => {
	assert.strictEqual(
		formatMessageForSuggestion({ role: "user", content: "fix the bug" }),
		"user: fix the bug",
	);
	assert.strictEqual(
		formatMessageForSuggestion({
			role: "assistant",
			content: [
				{ type: "text", text: "done" },
				{ type: "thinking", text: "internal" },
				{ type: "toolCall", name: "bash" },
			],
		}),
		"assistant: done\n[tool call: bash]",
	);
	assert.strictEqual(
		formatMessageForSuggestion({ type: "custom", content: [] }),
		"custom: [no text]",
	);
	assert.strictEqual(getMessageRole({ role: "user" }), "user");
	assert.strictEqual(getMessageRole({ type: "weird" }), "weird");
	assert.strictEqual(getMessageRole("garbage"), "message");
});

test("buildSuggestionContext uses recent messages only", () => {
	const messages: unknown[] = [];
	for (let i = 1; i <= 10; i++) {
		messages.push({ role: "user", content: `message ${i}` });
	}
	const context = buildSuggestionContext(messages as never[]);
	assert.ok(context.includes("message 3"));
	assert.ok(context.includes("message 10"));
	assert.ok(!context.includes("message 1\n"));
	assert.ok(!context.includes("message 2: "));
});

test("mergeConfigInputs provides defaults and merges overrides", () => {
	const defaults = mergeConfigInputs();
	assert.deepStrictEqual(defaults, {
		enabled: true,
		maxChars: 80,
		maxTokens: 1024,
		maxSuggestions: 3,
	});

	const merged = mergeConfigInputs({}, { enabled: false, model: "openai/gpt-5-mini" });
	assert.strictEqual(merged.enabled, false);
	assert.strictEqual(merged.model, "openai/gpt-5-mini");
});

test("normalizeConfigData backfills defaults for missing keys", () => {
	const normalized = normalizeConfigData({ enabled: false });
	assert.deepStrictEqual(normalized, {
		model: "default",
		enabled: false,
		maxChars: 80,
		maxTokens: 1024,
		maxSuggestions: 3,
	});
});

test("normalizeConfigData removes unsupported keys and preserves existing values", () => {
	const normalized = normalizeConfigData({
		model: "openai/gpt-5-mini",
		enabled: false,
		maxChars: 40,
		obsoleteKey: "gone",
	});
	assert.deepStrictEqual(normalized, {
		model: "openai/gpt-5-mini",
		enabled: false,
		maxChars: 40,
		maxTokens: 1024,
		maxSuggestions: 3,
	});
	assert.ok(!("obsoleteKey" in normalized));
});

test("parseConfigInput validates and warns on bad values", () => {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(message);

	assert.deepStrictEqual(
		parseConfigInput(
			{ enabled: true, maxChars: 40, maxSuggestions: 4, model: "x/y" },
			"cfg",
			warn,
		),
		{ enabled: true, maxChars: 40, maxSuggestions: 4, model: "x/y" },
	);
	assert.strictEqual(warnings.length, 0);

	assert.deepStrictEqual(parseConfigInput({ enabled: "yes", maxChars: -1 }, "cfg", warn), {});
	assert.ok(warnings.some((w) => w.includes("enabled must be boolean")));
	assert.ok(warnings.some((w) => w.includes("maxChars must be positive integer")));

	assert.deepStrictEqual(parseConfigInput("not an object", "cfg", warn), {});
	assert.ok(warnings.some((w) => w.includes("expected object")));
});

test("parseModelSpec parses provider/modelId", () => {
	assert.deepStrictEqual(parseModelSpec("openai/gpt-5-mini"), {
		provider: "openai",
		model: "gpt-5-mini",
	});
	assert.strictEqual(parseModelSpec("noslash"), undefined);
	assert.strictEqual(parseModelSpec("/model"), undefined);
	assert.strictEqual(parseModelSpec("provider/"), undefined);
});

test("isIntegerInRange bounds validation", () => {
	assert.strictEqual(isIntegerInRange(3, 1, 6), true);
	assert.strictEqual(isIntegerInRange(0, 1, 6), false);
	assert.strictEqual(isIntegerInRange(7, 1, 6), false);
	assert.strictEqual(isIntegerInRange(2.5, 1, 6), false);
	assert.strictEqual(isIntegerInRange("3", 1, 6), false);
});

test("truncatePlain shortens long text", () => {
	assert.strictEqual(truncatePlain("abc", 10), "abc");
	assert.strictEqual(truncatePlain("abc", 2), "a…");
});

test("candidatePoolSize doubles maxSuggestions with a floor of 2", () => {
	assert.strictEqual(candidatePoolSize(1), 2);
	assert.strictEqual(candidatePoolSize(3), 6);
	assert.strictEqual(candidatePoolSize(6), 12);
});

test("dedupeSuggestions keeps order and drops exact duplicates", () => {
	assert.deepStrictEqual(
		dedupeSuggestions(["commit this", "Commit this", "run the tests"]),
		["commit this", "run the tests"],
	);
});

test("dedupeSuggestions drops near-duplicates (containment and high token overlap)", () => {
	// Containment: one phrase contained in the other.
	assert.deepStrictEqual(dedupeSuggestions(["run the tests", "run the tests now"]), [
		"run the tests",
	]);
	// High token overlap (two of three tokens shared).
	assert.deepStrictEqual(dedupeSuggestions(["deploy the app", "deploy this app"]), [
		"deploy the app",
	]);
	assert.deepStrictEqual(dedupeSuggestions(["deploy the app", "deploy the apps"]), [
		"deploy the app",
	]);
	// Unshared wording survives.
	assert.deepStrictEqual(dedupeSuggestions(["commit this", "run the tests"]), [
		"commit this",
		"run the tests",
	]);
});
