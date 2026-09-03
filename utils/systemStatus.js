// Host metrics are collected at request time. Missing hardware is represented
// as null so the UI never has to invent a value.
//
// `si` is accepted as an optional param (defaulting to the real
// `systeminformation` module) purely so tests can inject a fake with the
// same method shape instead of needing real hardware/OS access — the
// sandboxed CI environment this runs in has neither a GPU nor a battery.
const os = require('os');
const fs = require('fs');
const realSi = require('systeminformation');

const safe = (value) => Promise.resolve(value).catch((err) => {
  console.warn('[system] metric failed:', err.message);
  return null;
});
const round = (value) => Number.isFinite(value) ? +value.toFixed(1) : null;

async function getSystemStatus(si = realSi) {
  const [cpuLoad, mem, disks, net, battery, graphics, cpuTemp, cpuInfo, osInfo, time, defaultInterface] = await Promise.all([
    safe(si.currentLoad()), safe(si.mem()), safe(si.fsSize()), safe(si.networkStats()),
    safe(si.battery()), safe(si.graphics()), safe(si.cpuTemperature()), safe(si.cpu()),
    safe(si.osInfo()), safe(si.time()), safe(si.networkInterfaceDefault()),
  ]);
  const diskList = Array.isArray(disks) ? disks.filter((d) => d.size > 0 && d.type !== 'tmpfs').map((d) => ({
    mount: d.mount || d.fs, usedPercent: Math.round(d.use || 0),
    usedGB: round((d.size - d.available) / 1e9), totalGB: round(d.size / 1e9), availableGB: round(d.available / 1e9),
  })) : [];
  // Some Windows builds return an empty fsSize list even though statfs works.
  // Fall back to the OS drive so the dashboard can still report real storage.
  if (diskList.length === 0 && process.platform === 'win32') {
    try {
      const stat = fs.statfsSync(process.env.SystemDrive || 'C:');
      const total = stat.blocks * stat.bsize;
      const available = stat.bavail * stat.bsize;
      diskList.push({ mount: process.env.SystemDrive || 'C:', usedPercent: Math.round(((total - available) / total) * 100), usedGB: round((total - available) / 1e9), totalGB: round(total / 1e9), availableGB: round(available / 1e9) });
    } catch (err) {
      console.warn('[system] disk fallback failed:', err.message);
    }
  }
  const primaryDisk = diskList.find((d) => /(^C:|\/$)/i.test(d.mount)) || diskList[0] || null;
  const interfaces = Array.isArray(net) && defaultInterface ? net.filter((n) => n.iface === defaultInterface) : net;
  const totals = Array.isArray(interfaces) && interfaces.length
    ? interfaces.reduce((a, n) => ({ rx: a.rx + (n.rx_sec || 0), tx: a.tx + (n.tx_sec || 0) }), { rx: 0, tx: 0 }) : null;
  const gpu = graphics?.controllers?.[0] || null;

  return {
    host: { hostname: os.hostname(), platform: osInfo ? `${osInfo.distro || os.type()} ${osInfo.release || ''}`.trim() : os.type(), uptimeSeconds: time?.uptime ?? os.uptime() },
    cpu: cpuLoad ? { loadPercent: Math.round(cpuLoad.currentLoad), cores: cpuLoad.cpus?.map((c) => Math.round(c.load)) ?? [], logicalCores: cpuInfo?.cores ?? cpuLoad.cpus?.length ?? null, physicalCores: cpuInfo?.physicalCores ?? null, model: cpuInfo?.brand ?? null, temperature: cpuTemp?.main ?? null } : null,
    memory: mem ? { usedPercent: Math.round((mem.used / mem.total) * 100), usedGB: round(mem.used / 1e9), totalGB: round(mem.total / 1e9), availableGB: round(mem.available / 1e9) } : null,
    disk: primaryDisk, disks: diskList,
    network: totals ? { interface: defaultInterface || null, downKBs: round(totals.rx / 1000), upKBs: round(totals.tx / 1000) } : null,
    gpu: gpu ? { model: gpu.model || null, loadPercent: gpu.utilizationGpu ?? null, vramUsedMB: gpu.memoryUsed ?? null, vramTotalMB: gpu.memoryTotal ?? null, temperature: gpu.temperatureGpu ?? null } : null,
    battery: battery?.hasBattery ? { percent: battery.percent, isCharging: battery.isCharging, timeRemainingMin: battery.timeRemaining > 0 ? battery.timeRemaining : null } : null,
    updatedAt: new Date().toISOString(),
  };
}

function formatStatus(s) {
  const p = [];
  if (s.cpu) p.push(`CPU ${s.cpu.loadPercent}%`);
  if (s.memory) p.push(`memory ${s.memory.usedGB}/${s.memory.totalGB} GB (${s.memory.usedPercent}%)`);
  if (s.disk) p.push(`${s.disk.mount} disk ${s.disk.availableGB} GB free of ${s.disk.totalGB} GB`);
  if (s.network) p.push(`network down ${s.network.downKBs}, up ${s.network.upKBs} KB/s`);
  if (s.battery) p.push(`battery ${s.battery.percent}%${s.battery.isCharging ? ', charging' : ''}`);
  return `Live status for ${s.host.hostname}: ${p.join('; ') || 'hardware metrics unavailable'}.`;
}

module.exports = { getSystemStatus, formatStatus };
