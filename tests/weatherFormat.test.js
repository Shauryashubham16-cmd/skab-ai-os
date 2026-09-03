const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  describe, iconGroup, findStartIndex, buildHourlyWindow, buildDailyForecast,
} = require('../utils/weatherFormat');

test('describe: maps known WMO codes to their label', () => {
  assert.equal(describe(0), 'Clear sky');
  assert.equal(describe(61), 'Slight rain');
  assert.equal(describe(95), 'Thunderstorm');
});

test('describe: unknown code falls back to "Unknown" rather than throwing', () => {
  assert.equal(describe(999), 'Unknown');
  assert.equal(describe(undefined), 'Unknown');
});

test('iconGroup: groups related codes into the same icon bucket', () => {
  assert.equal(iconGroup(0), 'clear');
  assert.equal(iconGroup(1), 'clear');
  assert.equal(iconGroup(61), 'rain');
  assert.equal(iconGroup(82), 'rain');
  assert.equal(iconGroup(71), 'snow');
  assert.equal(iconGroup(99), 'storm');
});

test('iconGroup: unrecognized code defaults to "cloudy", never undefined', () => {
  assert.equal(iconGroup(12345), 'cloudy');
});

test('findStartIndex: finds the first hourly slot at or after "now"', () => {
  const times = ['2026-08-29T10', '2026-08-29T11', '2026-08-29T12', '2026-08-29T13'];
  const now = new Date('2026-08-29T11:20:00Z');
  assert.equal(findStartIndex(times, now), 1);
});

test('findStartIndex: falls back to 0 when every timestamp is already in the past', () => {
  const times = ['2020-01-01T00', '2020-01-01T01'];
  const now = new Date('2026-08-29T11:20:00Z');
  assert.equal(findStartIndex(times, now), 0);
});

test('buildHourlyWindow: returns `count` hours starting at the resolved index, correctly shaped', () => {
  const hourly = {
    time: ['2026-08-29T10', '2026-08-29T11', '2026-08-29T12', '2026-08-29T13', '2026-08-29T14', '2026-08-29T15', '2026-08-29T16'],
    temperature_2m: [20, 21, 22, 23, 24, 25, 26],
    weather_code: [0, 0, 61, 61, 3, 3, 95],
  };
  const now = new Date('2026-08-29T11:05:00Z');
  const window = buildHourlyWindow(hourly, now, 3);
  assert.equal(window.length, 3);
  assert.deepEqual(window[0], { time: '2026-08-29T11', temp: 21, condition: 'Clear sky', icon: 'clear' });
  assert.deepEqual(window[2], { time: '2026-08-29T13', temp: 23, condition: 'Slight rain', icon: 'rain' });
});

test('buildDailyForecast: maps parallel arrays into one object per day', () => {
  const daily = {
    time: ['2026-08-29', '2026-08-30'],
    temperature_2m_max: [33, 31],
    temperature_2m_min: [26, 25],
    weather_code: [0, 61],
  };
  const result = buildDailyForecast(daily);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { date: '2026-08-29', tempMax: 33, tempMin: 26, condition: 'Clear sky', icon: 'clear' });
  assert.deepEqual(result[1], { date: '2026-08-30', tempMax: 31, tempMin: 25, condition: 'Slight rain', icon: 'rain' });
});
