/* ---------------- VOICE INPUT (live mic via Web Audio + SpeechRecognition) ---------------- */
// Two independent layers, both real:
//  1. Web Audio AnalyserNode drives the waveform bars from actual mic amplitude.
//  2. The browser's SpeechRecognition API (where supported) does real transcription
//     and feeds the confidence meter from its own confidence score.
// If SpeechRecognition isn't available (e.g. Firefox), the mic still visualizes
// real audio — it just won't auto-send a transcript, and the sub-text says so.
const micBtn = document.getElementById('micBtn');
const micBtnLabel = document.getElementById('micBtnLabel');
const voiceIndicators = document.getElementById('voiceIndicators');
const confidenceFill = document.getElementById('confidenceFill');
const nsBadge = document.getElementById('nsBadge');

let audioCtx = null, analyser = null, micStream = null, micRafId = null;
let recognition = null;
let micActive = false;

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

function drawMicLevels(){
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const step = Math.floor(data.length / waveformBars.length) || 1;
  let sum = 0;
  waveformBars.forEach((bar, i) => {
    const v = data[i * step] || 0;
    sum += v;
    bar.style.animation = 'none';
    bar.style.height = `${Math.max(4, (v / 255) * 34)}px`;
  });
  // Feed the same real amplitude into the particle field + voice ring so
  // "user speaks -> waveform reacts" also means "...and everything else reacts".
  window.JARVIS.voiceLevel = Math.min(1, (sum / waveformBars.length / 255) * 1.6);
  micRafId = requestAnimationFrame(drawMicLevels);
}

function resetWaveformToIdle(){
  cancelAnimationFrame(micRafId);
  waveformBars.forEach((bar) => {
    bar.style.height = '';
    bar.style.animation = '';
  });
}

async function startListening(){
  if (wakeActive && wakeRecognition) { try { wakeRecognition.stop(); } catch {} } // onend's own guard (wakeActive && !micActive) keeps it from restarting itself below
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    micBtn.classList.add('error');
    setReactorState('error', { main: 'Mic blocked', sub: err.message, revertAfter: 2500 });
    setTimeout(() => micBtn.classList.remove('error'), 2500);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  drawMicLevels();

  micActive = true;
  micBtn.classList.add('active');
  micBtnLabel.textContent = 'Stop Listening';
  voiceIndicators.style.display = 'flex';
  nsBadge.textContent = 'Noise suppression: ON';
  setReactorState('listening', { main: 'Listening…', sub: 'Speak now' });

  if (SpeechRecognitionCtor) {
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (e) => {
      const result = e.results[e.results.length - 1];
      const transcript = result[0].transcript;
      const confidence = result[0].confidence || 0;
      confidenceFill.style.width = `${Math.round(confidence * 100)}%`;
      stateSub.textContent = transcript;
      if (result.isFinal && transcript.trim()) {
        stopListening();
        sendChat(transcript);
      }
    };
    recognition.onerror = (e) => {
      console.warn('[voice] recognition error:', e.error);
      if (e.error !== 'no-speech') stopListening();
    };
    recognition.onend = () => { if (micActive) recognition.start(); }; // auto-restart while listening
    recognition.start();
  } else {
    stateSub.textContent = 'Live audio only — this browser has no built-in speech-to-text';
  }
}

function stopListening(){
  micActive = false;
  micBtn.classList.remove('active');
  micBtnLabel.textContent = 'Start Listening';
  voiceIndicators.style.display = 'none';
  confidenceFill.style.width = '0%';
  resetWaveformToIdle();
  if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  setReactorState('idle', { main: 'Ready', sub: 'Ask me anything…' });
  resumeWakeWordIfNeeded();
}

