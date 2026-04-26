# url2md

Convert any public URL to clean markdown via
[url2md.automators.work](https://url2md.automators.work) — a free, public
service that strips scripts, styles, navigation and boilerplate before
returning the article content.

This skill is the canonical example in this repo of **wrapping a real
public API as a skill** (rather than depending on a vendor MCP server).
Notably, the upstream service publishes its own `SKILL.md` and `llms.txt`
— it understands the same pattern this project advocates. Our wrapper
adds:

- Per-model schema overrides (Hermes drops the optional `raw` flag)
- Auto-fallback: on `422 extraction failed`, retry once with `raw=1`
  so the model doesn't have to learn that pattern itself
- Structured response with parsed `title`, `source`, `markdown`, `length`

## Usage

```bash
url2md --url "https://en.wikipedia.org/wiki/Unicode"
url2md --url "https://blog.example/post" --raw
```

### Composable pipelines

```bash
# Read a page and feed only the markdown body into the next stage
url2md --url "$URL" | jq -r '.markdown' | head -200

# Length check before deciding to summarize or quote
url2md --url "$URL" | jq '.length'
```

## Failure modes

| Status | Meaning | Handler behaviour |
|---|---|---|
| 400 | Invalid URL or private host | Throws — input validation |
| 413 | Upstream page > 5 MB | Throws — too large to process |
| 415 | Upstream not HTML | Throws — wrong content type |
| 422 | Readability extraction failed | **Auto-retries once with raw=1** |
| 502 | Upstream fetch failed | Throws — transient, caller can retry |

## Why a skill, not an MCP server

The upstream provider could have published an MCP server. Instead they
published a `SKILL.md` — a description of the API shaped for direct
consumption by an agent's skill catalog. We agree with that choice (see
[../../../PHILOSOPHY.md](../../../PHILOSOPHY.md)) and our skill is the
agent-side counterpart: ~50 lines of TypeScript that we own, that lives in
our repo, and that we tune per model without coordinating with anyone.
