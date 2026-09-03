/* ---------------- WAVEFORM ---------------- */
const wf = document.getElementById('waveform');
const waveformBars = [];
for(let i=0;i<40;i++){
  const bar = document.createElement('span');
  bar.style.animationDelay = (Math.random()*1.2)+'s';
  bar.style.animationDuration = (0.8+Math.random()*0.8)+'s';
  wf.appendChild(bar);
  waveformBars.push(bar);
}

