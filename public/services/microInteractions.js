/* ---------------- MICRO-INTERACTIONS ---------------- */
// Ripple: a small radial-gradient circle spawned at the click point, sized to
// the element it's clicked on, that expands and fades. Purely visual feedback.
function addRipple(el){
  el.style.position = el.style.position || 'relative';
  el.addEventListener('click', (e) => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.6;
    const ripple = document.createElement('span');
    ripple.className = 'jarvis-ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}
document.querySelectorAll('.mic-btn, .suggestions button, .power-btn, .term-tool-btn, .nav-item, .job-row')
  .forEach(addRipple);

// Magnetic hover: the element leans a few px toward the cursor while hovered.
function addMagnetic(el, strength = 8){
  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / rect.width;
    const dy = (e.clientY - rect.top - rect.height / 2) / rect.height;
    el.style.translate = `${dx * strength}px ${dy * strength}px`;
  });
  el.addEventListener('mouseleave', () => { el.style.translate = '0 0'; });
}
document.querySelectorAll('.nav-item, .mic-btn, .suggestions button, .power-btn').forEach((el) => addMagnetic(el, 6));

// Right-click context menu on the terminal card: Clear / Copy / Fullscreen.
const ctxMenu = document.createElement('div');
ctxMenu.className = 'jarvis-context-menu';
ctxMenu.style.display = 'none';
document.body.appendChild(ctxMenu);

function showContextMenu(x, y, items){
  ctxMenu.innerHTML = items.map((it, i) => `<div class="ctx-item" data-i="${i}">${it.label}</div>`).join('');
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  ctxMenu.style.display = 'block';
  ctxMenu.querySelectorAll('.ctx-item').forEach((el, i) => {
    el.addEventListener('click', () => { items[i].action(); ctxMenu.style.display = 'none'; });
  });
}
document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });

terminalCard.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: '🗑 Clear terminal', action: () => { termBody.innerHTML = ''; } },
    { label: '⧉ Copy logs', action: () => navigator.clipboard.writeText(termBody.innerText) },
    { label: '⛶ Toggle fullscreen', action: () => termFullscreenBtn.click() },
    { label: '⇩ Toggle autoscroll', action: () => termAutoscrollBtn.click() },
  ]);
});

