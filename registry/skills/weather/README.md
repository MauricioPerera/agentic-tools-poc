# weather

Wraps Open-Meteo's free `/v1/forecast` endpoint. No API key, no auth,
~10k requests/day per IP. Returns current temperature, wind, weather
code, and today's high/low for the given coordinates.

## Usage

```bash
weather --latitude 40.4168 --longitude -3.7038
# → {"location":"40.4168,-3.7038","temp_c":18.5,"wind_kph":12.3,"weather_code":3,...}
```

## Why

Open-Meteo publishes a deeply nested response with hourly arrays, units
metadata, and 30+ fields. Most agents asking "what's the weather" need
six values. This skill is the projection.

## WMO weather codes

The `weather_code` field is the WMO standard code, not a string. Common
values:

- 0 — clear sky
- 1-3 — mainly clear / partly cloudy / overcast
- 45-48 — fog
- 51-57 — drizzle
- 61-67 — rain
- 71-77 — snow
- 80-82 — rain showers
- 95 — thunderstorm

A downstream skill or prompt can map this to a human-readable string if
needed; we don't because the mapping is opinionated and locale-dependent.
