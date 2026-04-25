/**
 * exec-bash.mjs — runs a single bash command against the loaded registry and
 * prints {stdout, stderr, exitCode} as JSON to stdout. Used as the local
 * "tool executor" half of an external agent loop.
 *
 * Usage: node client/exec-bash.mjs '<bash command>'
 */
import { Bash } from 'just-bash';
import { loadRegistry } from './loader.mjs';
import { makeObservation } from './smart-bash.mjs';

const cmd = process.argv.slice(2).join(' ');
if (!cmd) { console.error('usage: exec-bash.mjs <command>'); process.exit(2); }

const RAW = process.env.RAW === '1';

const { manifest, commands } = await loadRegistry({ registry: process.env.REGISTRY });
const bash = new Bash({ customCommands: commands });
const r = await bash.exec(cmd);

const out = RAW
  ? { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 }
  : makeObservation(cmd, r, manifest);

process.stdout.write(JSON.stringify(out) + '\n');
