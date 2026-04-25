/**
 * ip-info
 * Validates the network-capable path: tool uses ctx.fetch which the loader
 * gates against the networkPolicy declared in tool.yaml.
 *
 * @param {{ ip?: string }} input
 * @param {{ fetch: typeof fetch, log: (msg: string) => void }} ctx
 */
export default async function handler(input, ctx) {
  const target = input.ip ? encodeURIComponent(input.ip) + '/' : '';
  const url = `https://ipapi.co/${target}json/`;
  ctx.log(`ip-info: GET ${url}`);
  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`ipapi.co returned ${res.status}`);
  const data = await res.json();
  return {
    ip:       data.ip,
    country:  data.country_name,
    city:     data.city,
    org:      data.org,
    timezone: data.timezone,
  };
}
