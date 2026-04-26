/**
 * demo.ts — proof that an agent-style bash session can discover + execute
 * remote tools (whose TS source lives in GitHub) end-to-end.
 *
 * Steps the agent (us, here) performs:
 *   1. Load registry → all tools become first-class bash commands
 *   2. Run a single tool
 *   3. Run a tool that hits a network endpoint (gated by networkPolicy)
 *   4. Compose two tools through a unix pipe
 */
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.ts';

const banner = (s: string) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 60 - s.length))}`);

// Allow SHA pinning via env var to bypass jsDelivr's @main cache (TTL ~7min).
const { manifest, commands } = await loadRegistry({ registry: process.env.REGISTRY });
banner(`Registry loaded: ${manifest.tools.length} tool(s)`);
for (const t of manifest.tools) console.log(`  • ${t.slug} v${t.version} — ${t.summary}`);

const bash = new Bash({ customCommands: commands as never });

banner('1) echo-pretty alone');
let r = await bash.exec('echo-pretty --text "hello world" --upper');
console.log('exitCode:', r.exitCode);
console.log('stdout:  ', r.stdout.trim());

banner('2) ip-info alone (live network call to api.country.is)');
r = await bash.exec('ip-info');
console.log('exitCode:', r.exitCode);
console.log('stdout:  ', r.stdout.trim());

banner('3) Pipeline: ip-info | jq -r .country | echo-pretty (stdin) --upper --prefix ">> "');
r = await bash.exec(`ip-info | jq -r '.country' | xargs -I {} echo-pretty --text "{}" --upper --prefix ">> "`);
console.log('exitCode:', r.exitCode);
console.log('stdout:  ', r.stdout.trim());
if (r.stderr) console.log('stderr:  ', r.stderr.trim());

banner('4) Network policy enforcement (negative test)');
console.log('  (skipped — would require modifying a tool to call a non-allowed host)');
console.log('  ctx.fetch in loader.ts throws if host not in tool.networkPolicy.allow.');

banner('Done');
