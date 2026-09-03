// Pure transforms for Open-Meteo responses — no network, no I/O. Previously
// these lived inline inside routes/weather.js's request handlers and were
// never exported, so the only way to exercise them was a real HTTP call
// through Express to a live (or mocked-at-the-axios-level) Open-Meteo
// endpoint. Pulling them out means they're now testable as plain functions.

// WMO weather codes -> human-readable condition (https://open-meteo.com/en/docs)
const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

function describe(code) {
  return WEATHER_CODES[code] || 'Unknown';
}

// Coarser grouping so the frontend can pick one animated icon/particle style
// per group instead of needing 28 distinct icons.
function iconGroup(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'cloudy';
}

// Finds the index of the first hourly timestamp >= `now`, falling back to 0
// if every timestamp is already in the past (stale/short forecast window).
function findStartIndex(hourlyTimes, now = new Date()) {
  const nowIso = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const idx = hourlyTimes.findIndex((t) => t.slice(0, 13) >= nowIso);
  return idx === -1 ? 0 : idx;
}

// Builds the next `count` hours of hourly data starting from `now`.
function buildHourlyWindow(hourly, now = new Date(), count = 6) {
  const startIdx = findStartIndex(hourly.time, now);
  return hourly.time.slice(startIdx, startIdx + count).map((time, i) => {
    const idx = startIdx + i;
    return {
      time,
      temp: hourly.temperature_2m[idx],
      condition: describe(hourly.weather_code[idx]),
      icon: iconGroup(hourly.weather_code[idx]),
    };
  });
}

function buildDailyForecast(daily) {
  return daily.time.map((date, i) => ({
    date,
    tempMax: daily.temperature_2m_max[i],
    tempMin: daily.temperature_2m_min[i],
    condition: describe(daily.weather_code[i]),
    icon: iconGroup(daily.weather_code[i]),
  }));
}

module.exports = { describe, iconGroup, findStartIndex, buildHourlyWindow, buildDailyForecast, WEATHER_CODES };
