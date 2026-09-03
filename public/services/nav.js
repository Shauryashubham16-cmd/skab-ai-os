/* ---------------- NAV ITEMS ---------------- */
const navIcons = [
  {name:'Home', active:true, icon:'<path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/>'},
  {name:'Assistant', icon:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'},
  {name:'Browser', icon:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>', dot:true},
  {name:'Memory', icon:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16M15 4v16M4 9h16M4 15h16"/>'},
  {name:'Vision', icon:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'},
  {name:'Imagination', icon:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8"/><circle cx="12" cy="12" r="3"/>'},
  {name:'Files', icon:'<path d="M4 4h6l2 2h8v12H4Z"/>'},
  {name:'Terminal', icon:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>', dot:'3'},
  {name:'Calendar', icon:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'},
  {name:'Calculator', icon:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>'},
  {name:'Automation', icon:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'},
  {name:'Settings', icon:'<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8 7 17M17 7l2.8-2.8"/>'}
];
const navList = document.getElementById('navList');
navIcons.forEach(n=>{
  const el = document.createElement('div');
  el.className = 'nav-item' + (n.active ? ' active' : '');
  el.title = n.name;
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${n.icon}</svg>` + (n.dot ? `<span class="dot"></span>` : '');
  el.addEventListener('click', ()=>{
    document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
    el.classList.add('active');
    // Every nav item that has a real panel/card behind it routes through
    // the same window.JARVIS.focusPanel() materialize-in animation (see
    // state/jarvisState.js) — Imagination/Settings/Terminal-fullscreen are
    // true overlays so they get the matching CSS animation for free instead.
    const focus = window.JARVIS && window.JARVIS.focusPanel;
    if (n.name === 'Home' && focus) focus(document.querySelector('.center'));
    if (n.name === 'Assistant' && focus) focus(document.getElementById('chatInputWrap'), { focus: document.getElementById('searchInput') });
    if (n.name === 'Memory' && focus) focus(document.getElementById('memoryCard'), { focus: document.getElementById('memSearchInput') });
    if (n.name === 'Vision' && focus) focus(document.getElementById('visionCard'));
    if (n.name === 'Automation' && focus) focus(document.getElementById('agentsCard'));
    if (n.name === 'Imagination' && typeof openImagination === 'function') openImagination();
    if (n.name === 'Terminal') document.getElementById('termFullscreenBtn')?.click();
    if (n.name === 'Calendar' && typeof openCalendarPanel === 'function') openCalendarPanel();
    if (n.name === 'Calculator' && typeof openCalculatorPanel === 'function') openCalculatorPanel();
    if (n.name === 'Settings' && typeof openSettings === 'function') openSettings();
    // 'Browser' and 'Files' have no dedicated panel/card in the dashboard
    // yet, so there's nothing to focus/open for them — left as plain nav
    // highlighting until those features get a real UI surface.
  });
  navList.appendChild(el);
});

