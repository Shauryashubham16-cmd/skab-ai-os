/* ---------------- CALCULATOR PANEL (live, via backend /api/calc) ----------------
   Closes the "calculator or file-manager panel" item from the README's
   "still genuinely open" list. Follows the same fetch/render pattern as
   components/Calendar/calendarPanel.js — safe server-side evaluation
   (utils/calculator.js, no eval), not a client-side eval() shortcut. */
const calcInput = document.getElementById('calcInput');
const calcResult = document.getElementById('calcResult');
const calcHistoryEl = document.getElementById('calcHistory');
const calcVarsEl = document.getElementById('calcVars');
const calculatorCard = document.getElementById('calculatorCard');

let calcHistory = [];
let calcDebounce = null;

function calcEscapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function calcFormatResult(n) {
  // Avoid float noise (0.1+0.2 -> 0.30000000000000004) without truncating
  // genuinely long results — 10 significant digits, trailing zeros trimmed.
  if (!Number.isFinite(n)) return String(n);
  const rounded = Number(n.toPrecision(10));
  return String(rounded);
}

async function loadCalcHistory() {
  try {
    const res = await fetch('/api/calc/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    calcHistory = data.history || [];
  } catch (err) {
    console.warn('[calculator] failed to load history', err);
    calcHistory = [];
  }
  renderCalcHistory();
}

// `ans` and any named variables (`x = 5`) — a thin strip above history so
// it's obvious what's referenceable right now without scrolling back
// through past results. See routes/calc.js's `scopes` Map for the backend
// side of this.
async function loadCalcVars() {
  try {
    const res = await fetch('/api/calc/vars');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderCalcVars(data.vars || {});
  } catch (err) {
    console.warn('[calculator] failed to load vars', err);
  }
}

function renderCalcVars(vars) {
  if (!calcVarsEl) return;
  const names = Object.keys(vars);
  if (!names.length) { calcVarsEl.innerHTML = ''; return; }
  // `ans` first if present, then alphabetical — keeps it findable as the
  // list of named variables grows.
  names.sort((a, b) => (a === 'ans' ? -1 : b === 'ans' ? 1 : a.localeCompare(b)));
  calcVarsEl.innerHTML = names.map((n) => `
    <span class="calc-var-chip" data-name="${calcEscapeHtml(n)}">${calcEscapeHtml(n)} = ${calcEscapeHtml(calcFormatResult(vars[n]))}</span>
  `).join('');
}

calcVarsEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.calc-var-chip');
  if (!chip) return;
  // Insert at the cursor rather than replace, so "x + " then clicking "ans"
  // appends instead of clobbering what's already typed.
  const name = chip.dataset.name;
  const el = calcInput;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + name + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + name.length;
});

function renderCalcHistory() {
  if (!calcHistory.length) {
    calcHistoryEl.innerHTML = `<div class="calc-empty-state">No calculations yet — type an expression above.</div>`;
    return;
  }
  calcHistoryEl.innerHTML = calcHistory.map((h) => `
    <div class="calc-history-row" data-expr="${calcEscapeHtml(h.expression)}">
      <span class="calc-history-expr">${calcEscapeHtml(h.expression)}</span>
      <span class="calc-history-val">= ${calcEscapeHtml(calcFormatResult(h.result))}</span>
    </div>
  `).join('');
}

calcHistoryEl.addEventListener('click', (e) => {
  const row = e.target.closest('.calc-history-row');
  if (!row) return;
  calcInput.value = row.dataset.expr;
  calcInput.focus();
  evaluateCalc();
});

async function evaluateCalc() {
  const expression = calcInput.value.trim();
  if (!expression) { calcResult.textContent = ''; calcResult.classList.remove('err'); return; }
  try {
    const res = await fetch('/api/calc/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression }),
    });
    const data = await res.json();
    if (data.ok) {
      calcResult.textContent = data.assignedName
        ? `${data.assignedName} = ${calcFormatResult(data.result)}`
        : `= ${calcFormatResult(data.result)}`;
      calcResult.classList.remove('err');
      await Promise.all([loadCalcHistory(), loadCalcVars()]);
    } else {
      calcResult.textContent = data.error || 'Invalid expression';
      calcResult.classList.add('err');
    }
  } catch (err) {
    calcResult.textContent = 'Calculator is unreachable right now.';
    calcResult.classList.add('err');
  }
}

// Live-evaluate as the user types (debounced), same "instant feedback"
// feel as a real calculator app — Enter also evaluates immediately and
// commits to history right away without waiting out the debounce.
calcInput.addEventListener('input', () => {
  clearTimeout(calcDebounce);
  calcDebounce = setTimeout(evaluateCalc, 350);
});
calcInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(calcDebounce); evaluateCalc(); }
});

// Nav wiring: clicking the "Calculator" nav item scrolls the dashboard card
// into view and focuses the input — same treatment Calendar/Imagination got.
function openCalculatorPanel() {
  if (!calculatorCard) return;
  if (window.JARVIS && window.JARVIS.focusPanel) {
    window.JARVIS.focusPanel(calculatorCard, { focus: calcInput });
  } else {
    calculatorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    calcInput.focus();
  }
}

loadCalcHistory();
loadCalcVars();

// ---- proactive insight toast --------------------------------------------
// Same idiom as calendarPanel.js's showCalendarToast — a second, independent
// producer (utils/proactiveAgent.js) now uses the same /agent socket +
// eventBus pipeline calendar reminders already proved out. Off by default
// server-side (ENABLE_PROACTIVE_AGENT), so this listener simply never fires
// unless the operator opted in.
function showInsightToast(payload) {
  const toast = document.createElement('div');
  toast.className = 'insight-toast';
  toast.innerHTML = `<b>Jarvis</b>${calcEscapeHtml(payload.message)}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 9000);
  if (typeof setReactorState === 'function') {
    setReactorState('complete', { main: 'Insight', sub: payload.message, revertAfter: 4000 });
  }
}

if (typeof agentSocket !== 'undefined') {
  agentSocket.on('agent:insight', showInsightToast);
}
