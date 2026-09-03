/* ---------------- MEMORY PANEL (live, via backend /api/memory/recent) ---------------- */
const memList = document.getElementById('memList');
const memSearchInput = document.getElementById('memSearchInput');
let memItems = [];
let memQuery = '';

function pinnedIds() {
  try { return new Set(JSON.parse(localStorage.getItem('jarvis_pinned_memories') || '[]')); }
  catch { return new Set(); }
}
function togglePin(id) {
  const pinned = pinnedIds();
  if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
  localStorage.setItem('jarvis_pinned_memories', JSON.stringify([...pinned]));
  renderMemory();
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function renderMemory() {
  const pinned = pinnedIds();
  const q = memQuery.trim().toLowerCase();
  const filtered = memItems.filter((it) => !q || it.content.toLowerCase().includes(q));
  const sorted = [...filtered].sort((a, b) => {
    const pa = pinned.has(a.id), pb = pinned.has(b.id);
    if (pa !== pb) return pa ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  if (!sorted.length) {
    memList.innerHTML = `<div class="mem-empty-state">${
      q ? 'No memories match that search.' : 'No memory yet — connect Supabase and start chatting to build a real history here.'
    }</div>`;
    return;
  }

  memList.innerHTML = sorted.slice(0, 12).map((it) => {
    const isPinned = pinned.has(it.id);
    return `<div class="mem-item ${isPinned ? 'pinned' : ''}">
      <span class="t">
        <button class="pin-btn" data-id="${escapeHtml(it.id)}" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '★' : '☆'}</button>
        <span class="content-text">${escapeHtml(it.content)}</span>
      </span>
      <span class="badge">${timeAgo(it.createdAt)}</span>
    </div>`;
  }).join('');

  memList.querySelectorAll('.pin-btn').forEach((btn) => {
    btn.addEventListener('click', () => togglePin(btn.dataset.id));
  });
}
async function loadMemory() {
  try {
    const res = await fetch('/api/memory/recent?limit=30');
    const data = await res.json();
    if (!data.connected) {
      memList.innerHTML = `<div class="mem-empty-state">Memory service unavailable right now.</div>`;
      return;
    }
    memItems = data.items || [];
    renderMemory();
  } catch (err) {
    console.warn('[memory] could not load:', err.message);
    memList.innerHTML = `<div class="mem-empty-state">Couldn't reach the memory service.</div>`;
  }
}
memSearchInput.addEventListener('input', () => { memQuery = memSearchInput.value; renderMemory(); });
loadMemory();
setInterval(loadMemory, 30000);
const RING_CIRCUMFERENCE = 151;
function setRing(ringId, labelId, subId, percent, labelText, subText) {
  const ring = document.getElementById(ringId);
  const label = document.getElementById(labelId);
  const sub = document.getElementById(subId);
  if (percent === null || percent === undefined) {
    ring.style.strokeDashoffset = RING_CIRCUMFERENCE;
    label.textContent = '—';
    sub.textContent = subText || 'unavailable';
    return;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * clamped) / 100;
  label.textContent = labelText !== undefined ? labelText : `${Math.round(clamped)}%`;
  sub.textContent = subText || '';
}

async function loadSystemStats() {
  try {
    const res = await fetch('/api/system');
    if (!res.ok) throw new Error('system stats request failed');
    const s = await res.json();

    setRing('ringCpu', 'labelCpu', 'subCpu', s.cpu?.loadPercent ?? null, undefined,
      s.cpu ? `${s.cpu.logicalCores ?? '?'} logical cores${s.cpu.temperature ? ' · ' + Math.round(s.cpu.temperature) + '°C' : ''}` : 'unavailable');

    setRing('ringRam', 'labelRam', 'subRam', s.memory?.usedPercent ?? null, undefined,
      s.memory ? `${s.memory.usedGB}/${s.memory.totalGB} GB` : 'unavailable');

    setRing('ringDisk', 'labelDisk', 'subDisk', s.disk?.usedPercent ?? null, undefined,
      s.disk ? `${s.disk.usedGB}/${s.disk.totalGB} GB` : 'unavailable');

    setRing('ringGpu', 'labelGpu', 'subGpu', s.gpu?.loadPercent ?? null,
      s.gpu?.loadPercent != null ? undefined : (s.gpu ? '—' : '—'),
      s.gpu ? (s.gpu.model || 'detected, no load data') : 'no GPU detected');

    // Network doesn't have a natural 0-100% ceiling, so the ring is a stylized
    // gauge scaled against a rough 5 MB/s reference — the real number is the
    // text underneath, which is what actually matters.
    const netKBs = s.network ? s.network.downKBs + s.network.upKBs : null;
    setRing('ringNet', 'labelNet', 'subNet', netKBs !== null ? Math.min(100, (netKBs / 5000) * 100) : null,
      netKBs !== null ? `${Math.round(netKBs)}` : undefined,
      s.network ? `↓${s.network.downKBs} ↑${s.network.upKBs} KB/s` : 'unavailable');

    if (s.battery) {
      setRing('ringBattery', 'labelBattery', 'subBattery', s.battery.percent, undefined,
        s.battery.isCharging ? '⚡ charging' : (s.battery.timeRemainingMin ? `${Math.round(s.battery.timeRemainingMin / 60)}h left` : 'on battery'));
    } else {
      setRing('ringBattery', 'labelBattery', 'subBattery', null, undefined, 'no battery (desktop)');
    }

    document.getElementById('sysStatusDot').style.color = 'var(--success)';
    document.getElementById('sysStatusDot').textContent = `● Live · ${new Date(s.updatedAt).toLocaleTimeString()}`;
  } catch (err) {
    console.warn('[system] could not load stats:', err.message);
    document.getElementById('sysStatusDot').style.color = 'var(--warning)';
    document.getElementById('sysStatusDot').textContent = '● Offline';
  }
}
loadSystemStats();
setInterval(loadSystemStats, 3000);
