/* ---------------- WEATHER (live, via backend /api/weather) ---------------- */
const WEATHER_ICONS = {
  clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  'partly-cloudy': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="3.5"/><path d="M15.5 19H8a5 5 0 1 1 4.9-6h.6a3.5 3.5 0 1 1 0 7Z"/></svg>',
  cloudy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 15H9a6 6 0 1 1 5.9-7h.6a4 4 0 1 1 0 8Z"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 14H9a6 6 0 1 1 5.9-7h.6a4 4 0 1 1 0 8Z"/><path d="M9 18v4M7 19l2 1 2-1M11 19l-2 1-2-1"/></svg>',
  storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 13H9a6 6 0 1 1 5.9-7h.6a4 4 0 1 1 0 7Z"/><path d="m13 15-2 4h3l-2 4"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h11M4 13h16M6 17h12"/></svg>',
};

function renderWeatherParticles(group) {
  const layer = document.getElementById('weatherParticles');
  layer.className = 'weather-particles grp-' + group;
  layer.innerHTML = '';

  if (group === 'rain' || group === 'storm') {
    for (let i = 0; i < 18; i++) {
      const d = document.createElement('div');
      d.className = 'rain-drop';
      d.style.left = `${Math.random() * 100}%`;
      d.style.animationDuration = `${0.5 + Math.random() * 0.4}s`;
      d.style.animationDelay = `${Math.random() * 1.5}s`;
      layer.appendChild(d);
    }
  } else if (group === 'snow') {
    for (let i = 0; i < 14; i++) {
      const d = document.createElement('div');
      d.className = 'snow-flake';
      d.style.left = `${Math.random() * 100}%`;
      d.style.animationDuration = `${2.5 + Math.random() * 2}s`;
      d.style.animationDelay = `${Math.random() * 3}s`;
      layer.appendChild(d);
    }
  } else if (group === 'cloudy' || group === 'partly-cloudy') {
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div');
      d.className = 'cloud-puff';
      d.style.top = `${10 + Math.random() * 40}%`;
      d.style.animationDuration = `${18 + Math.random() * 12}s`;
      d.style.animationDelay = `${-Math.random() * 20}s`;
      layer.appendChild(d);
    }
  }
}

async function loadWeather(){
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error('weather request failed');
    const w = await res.json();

    document.querySelector('.weather-cond').textContent = w.condition;
    document.querySelector('.weather-temp').textContent = `${Math.round(w.temp)}°C`;
    document.querySelector('.weather-feels').textContent = `Feels like ${Math.round(w.feelsLike)}°C`;
    document.getElementById('metaHumidity').textContent = `${w.humidity}%`;
    document.getElementById('metaWind').textContent = `${Math.round(w.windSpeed)} km/h`;
    document.getElementById('metaUv').textContent = w.uvIndex != null ? w.uvIndex.toFixed(1) : '—';
    document.getElementById('metaAqi').textContent = w.aqi != null ? w.aqi : '—';

    document.getElementById('weatherIcon').innerHTML = WEATHER_ICONS[w.icon] || WEATHER_ICONS.cloudy;
    renderWeatherParticles(w.icon || 'cloudy');

    const strip = document.getElementById('hourlyStrip');
    strip.innerHTML = (w.hourly || []).map((h) => {
      const hour = new Date(h.time).toLocaleTimeString([], { hour: 'numeric' });
      return `<div class="hourly-item">${hour}${WEATHER_ICONS[h.icon] || WEATHER_ICONS.cloudy}<b>${Math.round(h.temp)}°</b></div>`;
    }).join('');
  } catch (err) {
    console.warn('[weather] could not load:', err.message);
  }
}
loadWeather();
setInterval(loadWeather, 10 * 60 * 1000);

