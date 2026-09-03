/* ---------------- CLOCK ---------------- */
function updateClock(){
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('en-US',{hour12:false});
  document.getElementById('dateLine').textContent = now.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric', year:'numeric'}).toUpperCase();
}
updateClock(); setInterval(updateClock, 1000);

