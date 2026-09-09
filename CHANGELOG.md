# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- A transient "Generating suggestions..." line appears above the editor the
  moment a next-prompt suggestion starts generating and clears as soon as the
  candidates are ready to display. It is a static `aboveEditor` widget (no
  timer, no animated frames, no-op `invalidate`), so setting and clearing it
  each trigger a single redraw and it does not interfere with terminal
  scrollback. The line is left-padded by `outputPad` (default 1) to line up
  with the chat text, and is cleared on every terminal path — success, pending
  messages, a non-empty editor, an empty result, and an error — as well as on
  input and session resets.
- Graceful handling of settings-file failures. When `prompt-buffet.json`
  cannot be read, parsed, resynced, or written — or when the
  `extensions/` directory it lives in cannot be created — the extension
  now falls back to its built-in defaults for the rest of the session
  instead of throwing. `loadConfig` distinguishes the two first-run cases
  (directory-creation failure vs. seed-write failure) and, on either,
  latches a startup-failure state and surfaces a one-time warning above
  the editor at `session_start`.
- Once a startup failure latches, all filesystem I/O on the settings path
  is skipped for the session: the file is never read or written again. New
  `isErrorWithCode` and `describeError` helpers support the new
  error-classification path.

### Changed

- Config reads no longer silently swallow errors. `readConfigFile` returns
  `undefined` on a missing file (first run) and re-throws other read
  failures (including `ENOTDIR`) so the caller can latch into
  defaults-only mode; invalid JSON and non-object payloads now throw
  instead of being ignored. Config resync (`syncConfigFileKeys`) likewise
  throws on read/write failure rather than degrading quietly.
- `setEnabledInConfig` no longer returns the config path, and performs no
  disk I/O once a startup failure has latched.
- The `/prompt-buffet on|off` toggle applies to in-memory state only after
  a startup failure, so the extension remains usable without a working
  settings file.
- The single `prompt-buffet.ts` entry has been split into logical modules:
  `index.ts` (entry, event wiring, editor, widget state), `config.ts`
  (config loading/writing and model-spec resolution), `suggestions.ts`
  (generation pipeline, context building, sanitization/deduplication),
  and `utils.ts` (debug logging and small shared helpers). The
  `package.json` `pi.extensions` entry and `files` list now point at and
  ship these modules.

## [0.1.1] - 2026-09-07

### Fixed

- The config file at `<agent dir>/extensions/prompt-buffet.json` is now created
  even on a fresh install where the `extensions/` directory does not yet exist.
  `ensureConfigFile` and `setEnabledInConfig` create the parent directory with
  `mkdirSync(dirname, { recursive: true })` before writing.

## [0.1.0] - 2026-09-06

First public release. Prompt Buffet is a standalone fork of
[pi-prompt-suggestions](https://github.com/SteelDynamite/pi-prompt-suggestions),
retargeted from a single inline ghost-text suggestion to a ranked menu of
next-prompt candidates. Notable differences from the upstream project:

### Added

- Multiple ranked suggestions per turn — up to 3 by default, configurable from
  1 to 6 via `maxSuggestions` — instead of a single suggestion.
- Suggestions render as a numbered list in the widget below the editor. With
  the editor empty, typing a digit (1–6) fills the editor with that candidate.
- `maxSuggestions` config key (integer 1–6).
- `/prompt-buffet on|off` slash command with argument completions; persists
  the choice to the config file and applies from the next turn. With no valid
  argument it reports the current state.
- Near-duplicate elimination: candidates are de-duplicated before display using
  word-overlap similarity (one phrase contained in the other, or roughly 60%
  shared wording) in addition to exact normalization.
- JSON array response parsing (`parseSuggestionArray`) with tolerant fallbacks
  (JSON object → no suggestions, comma split for malformed arrays).
- Candidate over-generation: the model is asked for a candidate pool of
  `2 × maxSuggestions` (minimum 2), so useful suggestions still survive
  sanitization and de-duplication cuts.
- The system prompt is templated with `{maxChars}` and `{maxCandidates}` and
  rewritten for ranked multi-candidate output; the question-answering and
  explicit next-request heuristics were carried over and strengthened.
- Config file management: the config file
  (`~/.pi/agent/extensions/prompt-buffet.json`) is auto-created on first run,
  missing keys are backfilled with defaults, and keys the extension no longer
  supports are dropped (automatic config resync).
- Suggestion text is capitalized before display.
- Test suite (`tests/suggestions.test.ts`) covering parsing, sanitization,
  de-duplication, context building, and config handling.

### Changed

- Default suggestion model: uses the active session model
  (`"model": "default"`) instead of the upstream hardcoded
  `openai-codex/gpt-5.6-terra`. An explicitly configured `provider/model`
  still overrides; invalid specs fall back to the session model.
- Default `maxTokens` raised from 256 to 1024 to accommodate a candidate
  list instead of a single phrase.
- Sanitization retuned for multi-candidate output:
  - Word limit raised from 12 to 25 words per suggestion.
  - Dropped the "ends with a question mark" and "multiple sentences" rejections,
    since candidates may be questions answering the assistant.
  - Added rejection of bullet-prefixed items (`- item`, `• item`).
- Config keys reduced to: `enabled`, `model`, `maxChars`, `maxTokens`,
  `maxSuggestions`.

### Removed

- Ghost-text display mode: no inline ghost text is rendered in the editor and
  the `display` config key is gone. The custom editor component is still
  installed, solely to capture digit/typing input.
- Right Arrow, Enter, and Tab acceptance of the ghost suggestion, and the
  `acceptTab` config key.
- Project-level config (`.pi/prompt-suggestions.json`); configuration is
  global only.
- Custom non-TUI mode detection (InputSource tracking and `--mode` /
  `--print` argument scraping); TUI detection relies on `ctx.mode`.
