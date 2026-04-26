/**
 * github-repo-info — wraps GET /repos/{owner}/{repo} of the GitHub REST API.
 *
 * No auth required for low-rate use (60 req/h per IP). If GITHUB_TOKEN is
 * exposed via tool.yaml.requiredEnv, the loader passes it through ctx.env
 * and we use it as a Bearer token (5000 req/h authenticated).
 *
 * Defensive trimming + canonical output shape — handler never returns the
 * upstream's full 80-field payload, only what the outputSchema declares.
 *
 * Input/Output types come from `./types.gen.ts` — auto-generated from
 * `tool.yaml`. To change the contract, edit the YAML and run `npm run codegen`.
 */
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';

interface GitHubRepoResponse {
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  default_branch?: string;
  pushed_at?: string;
  html_url?: string;
}

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  if (!input.owner || !input.repo) {
    throw new Error('owner and repo are both required');
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  ctx.log(`GET ${url}`);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agentic-tools-poc',
  };
  if (ctx.env['GITHUB_TOKEN']) {
    headers['Authorization'] = `Bearer ${ctx.env['GITHUB_TOKEN']}`;
  }

  const res = await ctx.fetch(url, { headers });

  if (res.status === 404) {
    throw new Error(`repo ${input.owner}/${input.repo} not found (or private without auth)`);
  }
  if (res.status === 403) {
    throw new Error('GitHub API rate-limited (60 req/h unauth) — set GITHUB_TOKEN to raise to 5000 req/h');
  }
  if (!res.ok) {
    throw new Error(`github returned ${res.status}`);
  }

  const data = (await res.json()) as GitHubRepoResponse;

  const out: Output = {
    full_name:      data.full_name      ?? `${input.owner}/${input.repo}`,
    description:    data.description    ?? '',
    stars:          data.stargazers_count ?? 0,
    language:       data.language       ?? '',
    default_branch: data.default_branch ?? 'main',
    pushed_at:      data.pushed_at      ?? '',
    url:            data.html_url       ?? `https://github.com/${input.owner}/${input.repo}`,
  };
  return out;
};

export default handler;
