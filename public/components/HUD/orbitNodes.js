/* ---------------- ORBIT NODES ---------------- */
const nodes = [
  {name:'Browser', icon:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'},
  {name:'Memory', icon:'<rect x="4" y="4" width="16" height="16" rx="2"/>'},
  {name:'Vision', icon:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'},
  {name:'Files', icon:'<path d="M4 4h6l2 2h8v12H4Z"/>'},
  {name:'Weather', icon:'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 0 9Z"/>'},
  {name:'Code', icon:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'}
];
const orbitLayer = document.getElementById('orbitLayer');
const R = 250;
nodes.forEach((n,i)=>{
  const angle = (i / nodes.length) * Math.PI * 2 - Math.PI/2;
  const x = 280 + R * Math.cos(angle);
  const y = 280 + R * Math.sin(angle);
  const el = document.createElement('div');
  el.className='orbit-node';
  el.style.left = (x/560*100)+'%';
  el.style.top = (y/560*100)+'%';
  el.style.transform='translate(-50%,-50%)';
  el.innerHTML = `<div class="dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${n.icon}</svg></div><span>${n.name}</span>`;
  orbitLayer.appendChild(el);
});

