/**
 * weather — wraps Open-Meteo's free /v1/forecast endpoint.
 *
 * No API key, generous rate limits (10k/day per IP). We collapse the rich
 * upstream response into the six fields most agents actually use.
 *
 * Defensive layer: clamp/validate coords before sending. Open-Meteo would
 * accept lat=200 silently and return garbage; we throw early instead.
 *
 * Input/Output types come from `./types.gen.ts` — auto-generated from
 * `tool.yaml`. To change the contract, edit the YAML and run `npm run codegen`.
 */
import type { SkillHandler } from '../../../../types/index.ts';
import type { Input, Output } from './types.gen.ts';

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

const handler: SkillHandler<Input, Output> = async (input, ctx) => {
  const { latitude, longitude } = input;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new Error('latitude and longitude must be numbers');
  }
  if (latitude < -90 || latitude > 90) {
    throw new Error(`latitude ${latitude} out of range (-90 to 90)`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(`longitude ${longitude} out of range (-180 to 180)`);
  }

  const params = new URLSearchParams({
    latitude:  String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,wind_speed_10m,weather_code',
    daily:   'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '1',
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  ctx.log(`GET ${url}`);

  const res = await ctx.fetch(url);
  if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
  const data = (await res.json()) as OpenMeteoResponse;

  const current = data.current ?? {};
  const daily   = data.daily   ?? {};

  const out: Output = {
    location:       `${latitude},${longitude}`,
    temp_c:         current.temperature_2m ?? 0,
    wind_kph:       current.wind_speed_10m ?? 0,
    weather_code:   current.weather_code   ?? 0,
    forecast_max_c: daily.temperature_2m_max?.[0] ?? 0,
    forecast_min_c: daily.temperature_2m_min?.[0] ?? 0,
  };
  return out;
};

export default handler;
