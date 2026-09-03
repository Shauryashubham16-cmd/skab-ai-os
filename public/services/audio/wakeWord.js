/* ---------------- WAKE WORD ("Hey Jarvis") ----------------
   A second, independent SpeechRecognition instance that runs continuously
   in the background — separate from the push-to-talk one above — and
   listens only for the wake phrase. On a match it hands off straight into
   the normal startListening() flow for the actual command, so everything
   downstream (transcription, confidence meter, reactor states, sendChat)
   is exactly the same real pipeline the mic button uses; wake word is just
   a hands-free way to trigger it. Chrome/Edge only (same SpeechRecognition
   API constraint as push-to-talk) — the toggle explains itself if missing. */
const WAKE_PHRASE = /\b(?:hey\s+)?jarvis\b/i;
const wakeToggle = document.getElementById('wakeToggle');
const wakeToggleLabel = document.getElementById('wakeToggleLabel');
let wakeActive = false;
let wakeRecognition = null;

function startWakeWord(){
  if (!SpeechRecognitionCtor) {
    setReactorState('error', { main: 'Wake word unavailable', sub: 'This browser has no built-in speech recognition', revertAfter: 2500 });
    return;
  }
  wakeActive = true;
  wakeToggle.classList.add('active');
  wakeToggleLabel.textContent = 'Wake word: On — say "Hey Jarvis"';

  wakeRecognition = new SpeechRecognitionCtor();
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = true;
  wakeRecognition.lang = 'en-US';
  wakeRecognition.onresult = (e) => {
    const transcript = e.results[e.results.length - 1][0].transcript || '';
    if (!WAKE_PHRASE.test(transcript)) return;
    const command = transcript.replace(WAKE_PHRASE, '').trim();
    reactorBurst();
    try { wakeRecognition.stop(); } catch {}
    if (command.length > 3) {
      // Wake phrase + command said in one breath ("hey jarvis, what time is it") —
      // no need for a second listening round, just send it.
      sendChat(command);
    } else {
      // Just the wake phrase alone — open the normal listening flow for
      // whatever comes next, same as tapping the mic button.
      startListening();
    }
  };
  wakeRecognition.onerror = (e) => {
    console.warn('[wake] recognition error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'audio-capture' || e.error === 'service-not-allowed') stopWakeWord();
    // 'no-speech' and similar are expected in a mic that's listening 24/7 — ignored, onend restarts it.
  };
  wakeRecognition.onend = () => { if (wakeActive && !micActive) { try { wakeRecognition.start(); } catch {} } };
  try { wakeRecognition.start(); } catch (err) { console.warn('[wake] failed to start:', err.message); }
}

function stopWakeWord(){
  wakeActive = false;
  wakeToggle.classList.remove('active');
  wakeToggleLabel.textContent = 'Wake word: Off';
  if (wakeRecognition) { wakeRecognition.onend = null; try { wakeRecognition.stop(); } catch {} wakeRecognition = null; }
}

// Two SpeechRecognition instances can't both hold the mic at once — pause
// wake-word listening for the duration of an active push-to-talk/triggered
// listen, then pick it back up once that ends (called from stopListening()).
function resumeWakeWordIfNeeded(){
  if (wakeActive && wakeRecognition) { try { wakeRecognition.start(); } catch {} }
}

wakeToggle.addEventListener('click', () => { wakeActive ? stopWakeWord() : startWakeWord(); });

// Micro-interaction: a small expanding ripple centered on the click point,
// used on the mic button and (via delegation) any element opting in with
// class "rippleable". Purely cosmetic, self-cleans after the animation.
function spawnClickRipple(el, evt){
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.4;
  const span = document.createElement('span');
  span.className = 'click-ripple-span';
  span.style.width = span.style.height = size + 'px';
  const x = (evt && evt.clientX ? evt.clientX - rect.left : rect.width/2) - size/2;
  const y = (evt && evt.clientY ? evt.clientY - rect.top : rect.height/2) - size/2;
  span.style.left = x + 'px'; span.style.top = y + 'px';
  el.appendChild(span);
  setTimeout(() => span.remove(), 650);
}
micBtn.addEventListener('click', (e) => { spawnClickRipple(micBtn, e); micActive ? stopListening() : startListening(); });

