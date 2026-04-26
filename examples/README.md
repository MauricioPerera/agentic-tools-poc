# examples/

Real outputs of `client/smart-bash.ts::makeObservation` against the actual
registry, captured by running `npm run exec` against local `dist/`. These
are exactly what the model sees when it calls the composable `bash` tool
on the MCP server. No screenshots, no abstractions — copy-paste from the
shell.

Each file pairs the bash command (in the filename and at the top) with
the JSON observation. The "before" column is `RAW=1 npm run exec ...`
(only `stdout`, `stderr`, `exitCode`) and the "after" column is the
default smart-bash mode.

## Files

| File | Scenario |
|---|---|
| [01-clean-success.json](./01-clean-success.json) | A registry tool runs cleanly; observation includes `tools_referenced` with `jq_paths` and a `schema_check`. |
| [02-jq-path-error.json](./02-jq-path-error.json) | Model used `.ip.country` (nested) on a flat object. Smart-bash explains the shape and suggests valid paths. |
| [03-command-not-found.json](./03-command-not-found.json) | Model invented `curl`, which doesn't exist in just-bash sandbox. Diagnostic enumerates what IS available. |
| [04-pipeline-with-transform.json](./04-pipeline-with-transform.json) | Pipeline ends in `jq -r`; smart-bash notes the schema check is bypassed and suggests comparing to upstream tool's example. |
| [05-classic-mode-call.json](./05-classic-mode-call.json) | What the agent receives in classic mode — same skill, function-call shape instead of bash. |

## Why this matters

The PHILOSOPHY.md argument is "owning the skill catalog gives you control
over the observation contract". These files are the contract. The diff
between the raw and smart variants is what convinced Granite 4.0 H Micro
(3.4B, free tier) to converge correctly on queries it failed under the
default Workers AI tool-calling shape. See the README's "Validated against
Workers AI" section for the A/B numbers.

## Reproducing

```bash
npm run build                          # ensure dist/ exists
RAW=1 node client/exec-bash.ts "..."   # raw observation (baseline)
node client/exec-bash.ts "..."         # smart observation (default)
```
