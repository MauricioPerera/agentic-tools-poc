/**
 * ip-info
 * Validates the network-capable path: tool uses ctx.fetch which the loader
 * gates against the networkPolicy declared in tool.yaml.
 *
 * @param {{ ip?: string }} input
 * @param {{ fetch: typeof fetch, log: (msg: string) => void }} ctx
 */
// Recovery layer for the skill itself: small models love to invent values for
// optional args (Hermes 2 Pro filled this with "192.168.1.1", "not_specified",
// `true`, etc. in baseline runs). Treat obviously-bad inputs as "no IP given"
// rather than forwarding garbage to the upstream API.
const SENTINELS = new Set(['', 'auto', 'self', 'me', 'unknown', 'not_specified', 'none', 'null']);
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.|255\.)/;

function isUsableIp(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  if (SENTINELS.has(v)) return false;
  if (PRIVATE_IP.test(v)) return false;
  // Crude shape check: contains at least one dot (IPv4) or colon (IPv6)
  return /[.:]/.test(v);
}

export default async function handler(input, ctx) {
  const ip = isUsableIp(input?.ip) ? input.ip.trim() : null;
  const url = ip
    ? `https://api.country.is/${encodeURIComponent(ip)}`
    : `https://api.country.is/`;
  ctx.log(`GET ${url}${ip ? '' : ' (caller IP — ignored bad/missing input.ip)'}`);
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`country.is returned ${res.status}`);
  const data = await res.json();
  return { ip: data.ip, country: data.country };
}
