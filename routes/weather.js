const express = require('express');
const axios = require('axios');

const { validate } = require('../middleware/validate');
const { weatherQuery } = require('../schemas');
const { describe, iconGroup, findStartIndex, buildHourlyWindow, buildDailyForecast } = require('../utils/weatherFormat');

const router = express.Router();

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';


// GET /api/weather?lat=..&lon=..&units=metric|imperial  (defaults: Kolkata, metric)
router.get('/', validate({ query: weatherQuery }), async (req, res) => {
  const { lat = '22.5726', lon = '88.3639', units = 'metric' } = req.query;
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windUnit = units === 'imperial' ? 'mph' : 'kmh';

  try {
    // Forecast (temp/condition/hourly/uv) and air quality (AQI) are separate
    // Open-Meteo services, so fetch both in parallel. AQI is best-effort —
    // if it fails, everything else still returns.
    const forecastReq = axios.get(OPEN_METEO_BASE, {
      params: {
        latitude: lat,
        longitude: lon,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
        hourly: 'temperature_2m,weather_code,uv_index',
        daily: 'uv_index_max',
        temperature_unit: tempUnit,
        wind_speed_unit: windUnit,
        timezone: 'auto',
        forecast_days: 2,
      },
    });
    const aqiReq = axios
      .get(AIR_QUALITY_BASE, {
        params: { latitude: lat, longitude: lon, current: 'us_aqi', timezone: 'auto' },
      })
      .catch((err) => {
        console.warn('[weather] AQI lookup failed (non-fatal):', err.message);
        return null;
      });

    const [{ data }, aqiRes] = await Promise.all([forecastReq, aqiReq]);
    const c = data.current;
    const hourly = buildHourlyWindow(data.hourly);
    const startIdx = findStartIndex(data.hourly.time);
    const currentUv = data.hourly.uv_index?.[startIdx] ?? data.daily?.uv_index_max?.[0] ?? null;

    res.json({
      temp: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      condition: describe(c.weather_code),
      icon: iconGroup(c.weather_code),
      windSpeed: c.wind_speed_10m,
      uvIndex: currentUv,
      aqi: aqiRes?.data?.current?.us_aqi ?? null,
      hourly,
      units,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[weather] error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Failed to fetch weather', detail: err.response?.data?.reason || err.message });
  }
});

// GET /api/weather/forecast?lat=..&lon=..&days=5&units=metric|imperial
router.get('/forecast', validate({ query: weatherQuery }), async (req, res) => {
  const { lat = '22.5726', lon = '88.3639', units = 'metric', days = '5' } = req.query;
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';

  try {
    const { data } = await axios.get(OPEN_METEO_BASE, {
      params: {
        latitude: lat,
        longitude: lon,
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        temperature_unit: tempUnit,
        timezone: 'auto',
        forecast_days: days,
      },
    });

    const daily = buildDailyForecast(data.daily);

    res.json({ units, daily });
  } catch (err) {
    console.error('[weather/forecast] error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Failed to fetch forecast', detail: err.response?.data?.reason || err.message });
  }
});

module.exports = router;
