/**
 * Open-Meteo adapter — keyless weather model data with an open CORS policy.
 *
 * The API accepts comma-separated coordinate lists, so a whole wind grid is
 * one request rather than sixty-four.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export const WMO_CODES = Object.freeze({
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
});

export function describeWeatherCode(code) {
  return WMO_CODES[code] || 'Unknown';
}

export const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'visibility',
  'surface_pressure',
].join(',');

/** Build the multi-point request URL. */
export function forecastUrl(points, { hourly = null } = {}) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.lat.toFixed(3)).join(','),
    longitude: points.map((point) => point.lon.toFixed(3)).join(','),
    current: CURRENT_FIELDS,
    wind_speed_unit: 'ms',
    timezone: 'UTC',
  });
  if (hourly) params.set('hourly', hourly);
  const url = new URL(ENDPOINT);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Open-Meteo answers a single point with an object and multiple points with an
 * array. Normalise both so callers never branch.
 */
export function normalizeForecastList(payload) {
  if (!payload) return [];
  const list = Array.isArray(payload) ? payload : [payload];
  return list.map((entry) => ({
    lat: toNumber(entry?.latitude),
    lon: toNumber(entry?.longitude),
    elevationM: toNumber(entry?.elevation),
    time: entry?.current?.time || null,
    temperatureC: toNumber(entry?.current?.temperature_2m),
    apparentC: toNumber(entry?.current?.apparent_temperature),
    humidityPct: toNumber(entry?.current?.relative_humidity_2m),
    precipitationMm: toNumber(entry?.current?.precipitation),
    weatherCode: toNumber(entry?.current?.weather_code),
    windMs: toNumber(entry?.current?.wind_speed_10m),
    windDirDeg: toNumber(entry?.current?.wind_direction_10m),
    windGustMs: toNumber(entry?.current?.wind_gusts_10m),
    cloudCoverPct: toNumber(entry?.current?.cloud_cover),
    visibilityM: toNumber(entry?.current?.visibility),
    pressureHpa: toNumber(entry?.current?.surface_pressure),
  }));
}

export async function fetchForecastGrid(points, { signal } = {}, client = http) {
  if (!points?.length) return [];
  const { data } = await client.json(forecastUrl(points), {
    signal,
    timeoutMs: 20_000,
    cacheMs: 10 * 60 * 1000,
    retries: 1,
  });
  return normalizeForecastList(data);
}

export async function fetchConditions(lat, lon, { signal } = {}, client = http) {
  const [result] = await fetchForecastGrid([{ lat, lon }], { signal }, client);
  return result || null;
}
