// Durable storage for utils/scheduler.js's job map — closes the
// "in-memory only, a restart clears the schedule" gap that file used to
// document as an accepted limitation. Same JSON-file pattern as
// utils/taskStore.js and utils/longTermMemory.js: synchronous, zero setup.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'schedules.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(all) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function saveJob(id, job) {
  const all = load();
  all[id] = job;
  persist(all);
}

function deleteJob(id) {
  const all = load();
  if (!(id in all)) return;
  delete all[id];
  persist(all);
}

function loadAllJobs() {
  return load();
}

module.exports = { saveJob, deleteJob, loadAllJobs, FILE };
