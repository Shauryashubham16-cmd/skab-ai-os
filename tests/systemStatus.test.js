const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getSystemStatus, formatStatus } = require('../utils/systemStatus');

// formatStatus is already pure — no injection needed at all.
test('formatStatus: builds a one-line summary from whatever sections are present', () => {
  const s = {
    host: { hostname: 'jarvis-pc' },
    cpu: { loadPercent: 42 },
    memory: { usedGB: 8, totalGB: 16, usedPercent: 50 },
    disk: { mount: 'C:', availableGB: 100, totalGB: 500 },
    network: { downKBs: 120, upKBs: 30 },
    battery: { percent: 80, isCharging: true },
  };
  const line = formatStatus(s);
  assert.match(line, /jarvis-pc/);
  assert.match(line, /CPU 42%/);
  assert.match(line, /8\/16 GB \(50%\)/);
  assert.match(line, /battery 80%, charging/);
});

test('formatStatus: missing sections are omitted, not rendered as blanks/nulls', () => {
  const s = { host: { hostname: 'headless-box' }, cpu: null, memory: null, disk: null, network: null, battery: null };
  const line = formatStatus(s);
  assert.equal(line, 'Live status for headless-box: hardware metrics unavailable.');
});

// A fake systeminformation module — same method shape as the real one,
// resolves synchronously-ish with canned values. No real hardware queried.
function fakeSi(overrides = {}) {
  return {
    currentLoad: async () => ({ currentLoad: 35.4, cpus: [{ load: 30 }, { load: 40 }] }),
    mem: async () => ({ used: 8e9, total: 16e9, available: 8e9 }),
    fsSize: async () => [{ mount: 'C:', fs: 'C:', size: 500e9, available: 300e9, use: 40, type: 'ntfs' }],
    networkStats: async () => [{ iface: 'eth0', rx_sec: 1000, tx_sec: 500 }],
    battery: async () => ({ hasBattery: true, percent: 77, isCharging: false, timeRemaining: 120 }),
    graphics: async () => ({ controllers: [{ model: 'Fake GPU', utilizationGpu: 12, memoryUsed: 512, memoryTotal: 4096, temperatureGpu: 55 }] }),
    cpuTemperature: async () => ({ main: 61.2 }),
    cpu: async () => ({ cores: 8, physicalCores: 4, brand: 'Fake CPU' }),
    osInfo: async () => ({ distro: 'Windows', release: '11' }),
    time: async () => ({ uptime: 12345 }),
    networkInterfaceDefault: async () => 'eth0',
    ...overrides,
  };
}

test('getSystemStatus: shapes a full fake reading into the expected structure', async () => {
  const status = await getSystemStatus(fakeSi());
  assert.equal(status.cpu.loadPercent, 35);
  assert.equal(status.memory.usedPercent, 50);
  assert.equal(status.memory.usedGB, 8);
  assert.equal(status.disk.mount, 'C:');
  assert.equal(status.disk.usedPercent, 40);
  assert.equal(status.network.interface, 'eth0');
  assert.equal(status.gpu.model, 'Fake GPU');
  assert.equal(status.battery.percent, 77);
  assert.equal(status.battery.isCharging, false);
});

test('getSystemStatus: a metric that rejects is reported as null, not thrown', async () => {
  const si = fakeSi({ battery: async () => { throw new Error('no battery on this box'); } });
  const status = await getSystemStatus(si);
  assert.equal(status.battery, null);
  // everything else still comes through
  assert.equal(status.cpu.loadPercent, 35);
});

test('getSystemStatus: no battery hardware reports null rather than a fake reading', async () => {
  const si = fakeSi({ battery: async () => ({ hasBattery: false }) });
  const status = await getSystemStatus(si);
  assert.equal(status.battery, null);
});

test('getSystemStatus: empty fsSize list on a non-Windows platform yields an empty disk list (no invented disk)', async () => {
  if (process.platform === 'win32') return; // fallback path only applies off-Windows in this assertion
  const si = fakeSi({ fsSize: async () => [] });
  const status = await getSystemStatus(si);
  assert.deepEqual(status.disks, []);
  assert.equal(status.disk, null);
});
