/* ---------------- REACTIVE PARTICLE FIELD ---------------- */
// Particles react to three live inputs: mouse position (gentle repel),
// window.JARVIS.voiceLevel (0-1, set by mic/TTS analysers or idle ambient
// sine below), and window.JARVIS.currentState (drives color + speed).
const STATE_COLOR = {
  idle:          [150,230,255],
  listening:     [110,255,190],
  understanding: [140,200,255],
  planning:      [170,160,255],
  thinking:      [190,140,255],
  executing:     [255,190,110],
  observing:     [255,205,140],
  verifying:     [150,255,170],
  speaking:      [130,240,255],
  complete:      [150,255,190],
  error:         [255,90,110],
};
window.JARVIS.voiceLevel = 0;
const canvas = document.getElementById('particles');
const ctx = canvas.getContext('2d');
let W,H;
function resize(){ W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize(); window.addEventListener('resize', resize);
const mouse = { x: -9999, y: -9999, active: false };
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; });
window.addEventListener('mouseleave', () => { mouse.active = false; });
const particles = Array.from({length:160}, ()=>({
  x: Math.random()*W, y: Math.random()*H,
  r: Math.random()*1.4+0.3,
  vx: (Math.random()-0.5)*0.15,
  vy: (Math.random()-0.5)*0.15,
  a: Math.random()*0.6+0.15,
  tw: Math.random()*0.02+0.005
}));
function loop(){
  ctx.clearRect(0,0,W,H);
  const state = window.JARVIS.currentState || 'idle';
  const [cr,cg,cb] = STATE_COLOR[state] || STATE_COLOR.idle;
  const level = window.JARVIS.voiceLevel || 0;          // 0-1
  const STATE_SPEED = { thinking:1.4, planning:1.1, understanding:0.7, executing:0.9, observing:1.0, verifying:0.8, complete:0.5 };
  const speedMul = 1 + level * 3 + (STATE_SPEED[state] || 0);
  particles.forEach(p=>{
    p.x += p.vx * speedMul; p.y += p.vy * speedMul;
    p.a += p.tw * (1 + level * 2);
    if(p.x<0) p.x=W; if(p.x>W) p.x=0;
    if(p.y<0) p.y=H; if(p.y>H) p.y=0;

    // gentle repel from the cursor — a soft, non-physical parallax push
    if (mouse.active) {
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const distSq = dx*dx + dy*dy;
      if (distSq < 14400) { // within 120px
        const dist = Math.sqrt(distSq) || 1;
        const force = (1 - dist/120) * 0.6;
        p.x += (dx/dist) * force; p.y += (dy/dist) * force;
      }
    }

    const alpha = ((Math.sin(p.a)+1)/2 * 0.7 + 0.1) * (0.65 + level*0.5);
    const rad = p.r * (1 + level * 1.8);
    ctx.beginPath();
    ctx.arc(p.x,p.y,rad,0,Math.PI*2);
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1,alpha)})`;
    ctx.fill();
  });
  requestAnimationFrame(loop);
}
loop();

