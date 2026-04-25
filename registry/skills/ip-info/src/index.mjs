/**
 * ip-info
 * Validates the network-capable path: tool uses ctx.fetch which the loader
 * gates against the networkPolicy declared in tool.yaml.
 *
 * @param {{ ip?: string }} input
 * @param {{ fetch: typeof fetch, log: (msg: string) => void }} ctx
 */
export default async function handler(input, ctx) {
  const url = input.ip
    ? `https://api.country.is/${encodeURIComponent(input.ip)}`
    : `https://api.country.is/`;
  ctx.log(`GET ${url}`);
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`country.is returned ${res.status}`);
  const data = await res.json();
  return { ip: data.ip, country: data.country };
}
