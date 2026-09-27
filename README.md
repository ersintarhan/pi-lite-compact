# pi-lite-compact

Pi's native compaction, but summarized by a model you choose.

- **Custom summary model.** On `session_before_compact` it calls pi's own exported `compact()` with your model. You keep pi's prompt, cut point, split-turn handling, iterative previous summary and file lists. Nothing is reimplemented.
- **Native fallback.** If the model is missing, auth fails, or the call errors (for example because the summary model's context is too small), the hook returns nothing and pi compacts natively with the session model.
- **Optional early trigger.** With `thresholdPercent`, it requests a compaction when an idle session's context reaches that percentage.
- **File lists survive.** Pi only carries file lists forward from its own compactions. This extension re-adds them from the previous one.

About 150 lines, one file, no runtime dependencies.

## Install

```bash
pi install npm:@ersintarhan/pi-lite-compact
# or: pi install git:github.com/ersintarhan/pi-lite-compact
```

## Config

Create `~/.pi/agent/lite-compact.json`. It is re-read on every event, so no reload is needed:

```json
{
  "model": "minimax/MiniMax-M3",
  "thresholdPercent": 60
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | unset: native compaction untouched | `provider/modelId` that writes the summary. Model ids may contain `/`. |
| `thresholdPercent` | unset: pi's own trigger only | Compact after the agent settles once context is at or above this percentage of the window. |

The keep/reserve budgets are still controlled by pi's `compaction` settings (`keepRecentTokens`, `reserveTokens`, `modelOverrides`).

`thresholdPercent` works even when `compaction.enabled` is `false`. It requests the same compaction that `/compact` does. `/compact [instructions]` also uses the configured model.

## Development

```bash
bun install
bun run check   # tsc + bun test
```
