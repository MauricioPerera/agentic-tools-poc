# github-repo-info

Wraps `GET https://api.github.com/repos/{owner}/{repo}` and returns the
fields an agent typically needs (stars, language, description, last push,
default branch). Drops the other ~70 fields the API returns.

## Usage

```bash
github-repo-info --owner cloudflare --repo workers-sdk
# → {"full_name":"cloudflare/workers-sdk","description":"⛅️ Home to Wrangler...","stars":3415,"language":"TypeScript",...}
```

## Auth

Unauthenticated calls work but share a 60-req/hour bucket per IP. If
`GITHUB_TOKEN` is set in the host environment, the loader passes it
through `ctx.env` (gated by `tool.yaml.requiredEnv`) and we use it as a
Bearer token, raising the limit to 5000 req/h.

## Why a thin wrapper instead of GitHub's own MCP

GitHub publishes a more capable MCP server. We wrap one specific
endpoint here because:

- The 80-field upstream response is ~5KB JSON; our trimmed output is ~200 bytes.
  Tokens crossing the model boundary drop an order of magnitude.
- We control the failure messages — "rate-limited, try GITHUB_TOKEN" is
  more actionable than the raw 403 body.
- Per-model tuning is possible (e.g. drop the `default_branch` field on
  small models that don't need it).

This is the [PHILOSOPHY.md](../../../PHILOSOPHY.md) argument made concrete:
the API is the contract; how the agent consumes it belongs to the agent.
