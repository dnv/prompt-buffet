# Manual testing guide

Run an interactive session from the extension root (or any directory):

```bash
cd ~/.pi/agent/extensions/prompt-buffet
pi
```

The global extension is loaded automatically. Useful checks:

1. Ask pi to do an obvious two-step task (e.g. "commit this once done").
2. After the agent responds, a numbered suggestion list appears below the editor.
3. In the empty editor:
   - press `1`-`N` (where N is `maxSuggestions`) to fill the editor with that suggestion — this does **not** submit, so review it and press Enter yourself to send,
   - press anything else (`Enter`, `Tab`, `Backspace`, letters) to clear the suggestions; normal editor behavior is otherwise unchanged.
4. Suggestions are only generated when config is `enabled`, the editor is empty, there are no pending messages, and a model resolves.
5. `/prompt-buffet on|off` toggles the feature at runtime; it applies from the next turn.

Debug mode writes to `prompt-buffet-debug.log` in the current directory and shows status via `ctx.ui`:

```bash
PROMPT_BUFFET_DEBUG=1 pi
```

Config is global only, at `~/.pi/agent/extensions/prompt-buffet.json`:

```json
{
  "enabled": true,
  "model": "default",
  "maxChars": 80,
  "maxTokens": 1024,
  "maxSuggestions": 3
}
```

`model` is `provider/modelId` or `"default"` (active Pi model).
