// Listening through Whisper. The microphone is recorded without a break and cut into
// clips at natural pauses; each clip is sent to the server for transcription. Because
// recording never stops, nothing said between clips is lost.

const FRAME_MS = 50; // how often the microphone level is measured
const MIN_CLIP_MS = 2500; // don't end a clip sooner than this
const PAUSE_MS = 450; // a pause this long ends the clip
const MAX_CLIP_MS = 12000; // nonstop speech is cut here regardless
const MIN_SPEECH_MS = 300; // clips with less speech than this are not sent
const IDLE_CLIP_MS = 6000; // a clip with no speech is dropped after this long
const FLOOR_FRAMES = 60; // the background noise level is the quietest of this many frames

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function whisperSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));
}

// getPrompt() returns the end of the transcript so far; onText(text) receives each
// transcribed clip in order; onError(message) reports a failed clip; onDrained() is
// called after stop() once the last clip has been transcribed.
export function createWhisperEngine({ getPrompt, onText, onError, onDrained }) {
  let stream = null;
  let context = null;
  let analyser = null;
  let samples = null;
  let recorder = null;
  let timer = null;
  let mime = "";
  let stopped = true;

  let clipStart = 0;
  let speechMs = 0;
  let quietMs = 0;
  let recent = []; // recent frame levels, for estimating background noise

  const queue = [];
  let sending = false;

  function startRecorder() {
    const next = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const parts = [];
    next.ondataavailable = (event) => {
      if (event.data.size) parts.push(event.data);
    };
    // Each recorder produces one complete audio file when stopped.
    next.finish = (keep) =>
      new Promise((resolve) => {
        next.onstop = () => {
          if (keep && parts.length) enqueue(new Blob(parts, { type: next.mimeType || mime }));
          resolve();
        };
        next.stop();
      });
    next.start();
    clipStart = performance.now();
    speechMs = 0;
    quietMs = 0;
    return next;
  }

  // End the current clip and begin the next. The new recorder starts before the old one
  // stops, so the two overlap by a moment instead of leaving a gap.
  function rotate(keep) {
    const old = recorder;
    recorder = startRecorder();
    old.finish(keep);
  }

  function measure() {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const level = Math.sqrt(sum / samples.length);

    recent.push(level);
    if (recent.length > FLOOR_FRAMES) recent.shift();
    const floor = Math.min(...recent);
    const speaking = level > Math.max(0.008, floor * 3 + 0.004);

    if (speaking) {
      speechMs += FRAME_MS;
      quietMs = 0;
    } else {
      quietMs += FRAME_MS;
    }

    const age = performance.now() - clipStart;
    const hasSpeech = speechMs >= MIN_SPEECH_MS;
    if (hasSpeech && ((age >= MIN_CLIP_MS && quietMs >= PAUSE_MS) || age >= MAX_CLIP_MS)) rotate(true);
    else if (!hasSpeech && age >= IDLE_CLIP_MS) rotate(false);
  }

  function enqueue(clip) {
    queue.push(clip);
    send();
  }

  // Clips are sent one at a time so their text comes back in the order it was spoken.
  async function send() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const clip = queue.shift();
      try {
        const query = new URLSearchParams({ type: clip.type, prompt: getPrompt() });
        const response = await fetch(`/api/transcribe?${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: clip,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Transcription failed (${response.status}).`);
        if (body.text) onText(body.text);
      } catch (error) {
        onError(error instanceof TypeError ? "Can't reach the server." : error.message);
      }
    }
    sending = false;
    if (stopped) onDrained();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const blocked = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      throw Object.assign(new Error("microphone"), {
        userMessage: blocked ? "Microphone blocked. Allow it in site settings" : "No microphone found",
      });
    }
    context = new (window.AudioContext || window.webkitAudioContext)();
    await context.resume();
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    samples = new Float32Array(analyser.fftSize);
    context.createMediaStreamSource(stream).connect(analyser);

    mime = TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    recent = [];
    stopped = false;
    recorder = startRecorder();
    timer = setInterval(measure, FRAME_MS);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    const last = recorder;
    recorder = null;
    await last.finish(speechMs >= MIN_SPEECH_MS);
    for (const track of stream.getTracks()) track.stop();
    context.close();
    if (!sending && !queue.length) onDrained();
  }

  return { start, stop };
}
