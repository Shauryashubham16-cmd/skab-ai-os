/* ---------------- VOICE-RING DRIVER (idle ambient + mic + TTS) ---------------- */
// Keeps window.JARVIS.voiceLevel and the SVG ring around the core alive at
// all times: a gentle synthetic sine when nothing is happening, real mic
// amplitude while listening, real TTS playback amplitude while speaking.
const voiceRingCircle = document.getElementById('voiceRingCircle');
let ambientPhase = 0;
function driveVoiceRingAmbient(){
  if (!micActive && !window.JARVIS.speakingLevel) {
    ambientPhase += 0.03;
    const v = (Math.sin(ambientPhase)+1)/2 * 0.18 + 0.04; // small idle breathing
    window.JARVIS.voiceLevel = v;
  }
  if (voiceRingCircle) {
    const lvl = window.JARVIS.voiceLevel || 0;
    voiceRingCircle.setAttribute('r', 110 + lvl * 55);
    voiceRingCircle.style.opacity = 0.25 + lvl * 0.6;
    voiceRingCircle.style.strokeWidth = 1 + lvl * 3;
  }
  requestAnimationFrame(driveVoiceRingAmbient);
}
driveVoiceRingAmbient();

