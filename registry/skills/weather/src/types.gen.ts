// ╔════════════════════════════════════════════════════════════════════╗
// ║ AUTO-GENERATED from tool.yaml — DO NOT EDIT BY HAND.               ║
// ║ Run `npm run codegen` after changing inputSchema or outputSchema.  ║
// ║ CI runs `npm run codegen:check` to fail builds on drift.           ║
// ╚════════════════════════════════════════════════════════════════════╝

/** Skill input — Current weather + today's high/low for given coordinates. No API key. */
export interface Input {
  /** Decimal degrees, -90 to 90 (north positive). */
  latitude: number;
  /** Decimal degrees, -180 to 180 (east positive). */
  longitude: number;
}

/** Skill output */
export interface Output {
  /** lat,lon canonical string, useful for downstream display. */
  location?: string;
  /** Current temperature in Celsius. */
  temp_c?: number;
  /** Current wind speed in km/h. */
  wind_kph?: number;
  /** WMO weather code (0=clear, 3=overcast, 51-67=rain, 71-77=snow, 95=thunderstorm). See https://open-meteo.com/en/docs. */
  weather_code?: number;
  /** Today's forecast high in Celsius. */
  forecast_max_c?: number;
  /** Today's forecast low in Celsius. */
  forecast_min_c?: number;
}
