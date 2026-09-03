/* ---------------- REACTOR TILT ---------------- */
const reactorWrap = document.getElementById('reactorWrap');
document.querySelector('.center').addEventListener('mousemove', (e)=>{
  const rect = reactorWrap.getBoundingClientRect();
  const cx = rect.left + rect.width/2;
  const cy = rect.top + rect.height/2;
  const dx = (e.clientX - cx) / rect.width;
  const dy = (e.clientY - cy) / rect.height;
  reactorWrap.style.transform = `perspective(1200px) rotateY(${dx*6}deg) rotateX(${-dy*6}deg)`;
});
document.querySelector('.center').addEventListener('mouseleave', ()=>{
  reactorWrap.style.transform = 'none';
});
reactorWrap.style.transition = 'transform .3s ease-out';

