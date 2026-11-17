const CONTEXT_SEGMENTS = 8; // earlier segments sent along so the model can follow the argument
const DEBOUNCE_MS = 900; // wait for a pause before checking, so nearby phrases go in one request
const MIN_WORDS = 4; // don't spend a request on a fragment; it rides along with the next phrase
const MAX_BATCH = 20;

const CATEGORY_LABELS = {
  fallacy: "Fallacy",
  pressure_tactic: "Pressure tactic",
  statistical_red_flag: "Statistics red flag",
};

const EXAMPLE = [
  "So I looked at the plan you sent over and I think the price is a bit high for us",
  "Honestly everyone in your industry has already signed up so you'd be the only one left behind",
  "And this price is only valid until tonight after that I can't guarantee anything",
  "Studies show that companies using this grow three hundred percent faster",
  "Can you send me the contract so I can read it over the weekend",
];

const els = {
  listen: document.getElementById("listen"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  transcript: document.getElementById("transcript"),
  transcriptEmpty: document.getElementById("transcript-empty"),
  flags: document.getElementById("flags"),
  flagsEmpty: document.getElementById("flags-empty"),
  flagCount: document.getElementById("flag-count"),
  form: document.getElementById("type-form"),
  input: document.getElementById("type-input"),
  example: document.getElementById("example"),
};

const state = {
  segments: [], // { id, text, checked }
  flags: [], // { id, segment_id, quote, category, name, explanation, suggested_response, confidence }
  interim: "",
  nextId: 1,
  inFlight: false,
  timer: null,
  listening: false,
};

// ---------- Analysis queue ----------

function addSegment(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return;
  state.segments.push({ id: `s${state.nextId++}`, text: clean, checked: false });
  renderTranscript();
  scheduleAnalysis();
}

function scheduleAnalysis(delay = DEBOUNCE_MS) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => runAnalysis(false), delay);
}

function wordCount(segments) {
  return segments.reduce((n, s) => n + s.text.split(" ").length, 0);
}

async function runAnalysis(force) {
  if (state.inFlight) return; // the running request re-schedules when it finishes
  const firstPending = state.segments.findIndex((s) => !s.checked);
  if (firstPending === -1) return;

  const batch = state.segments.slice(firstPending).filter((s) => !s.checked).slice(0, MAX_BATCH);
  if (!force && wordCount(batch) < MIN_WORDS) {
    // Too short to judge. Check it anyway if nothing else arrives for a while.
    clearTimeout(state.timer);
    state.timer = setTimeout(() => runAnalysis(true), 4000);
    return;
  }
  const context = state.segments.slice(Math.max(0, firstPending - CONTEXT_SEGMENTS), firstPending);
  const toWire = (s) => ({ id: s.id, text: s.text });

  state.inFlight = true;
  let failed = false;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: context.map(toWire), segments: batch.map(toWire) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Analysis failed (${res.status}).`);

    for (const segment of batch) segment.checked = true;
    for (const flag of body.flags ?? []) {
      state.flags.push({ ...flag, id: `f${state.flags.length + 1}` });
    }
    showError(null);
  } catch (error) {
    // Leave the batch unchecked; it is retried with the next phrase that arrives.
    failed = true;
    showError(error instanceof TypeError ? "Can't reach the server. Is it still running?" : error.message);
  } finally {
    state.inFlight = false;
    render();
    if (!failed && state.segments.some((s) => !s.checked)) scheduleAnalysis(0);
  }
}

// ---------- Rendering ----------

function showError(message) {
  els.error.hidden = !message;
  els.error.textContent = message ?? "";
}

function render() {
  renderTranscript();
  renderFlags();
}

// Split a segment's text into plain and flagged pieces.
function markRanges(segment) {
  const lower = segment.text.toLowerCase();
  const ranges = [];
  for (const flag of state.flags) {
    if (flag.segment_id !== segment.id) continue;
    let start = lower.indexOf(flag.quote.trim().toLowerCase());
    let end = start + flag.quote.trim().length;
    if (start === -1 || end === start) {
      // The model's quote didn't match the text exactly: mark the whole segment.
      start = 0;
      end = segment.text.length;
    }
    if (ranges.every((r) => end <= r.start || start >= r.end)) ranges.push({ start, end, flag });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function renderTranscript() {
  const nearBottom =
    els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 60;
  const nodes = [];

  for (const segment of state.segments) {
    const span = document.createElement("span");
    span.className = segment.checked ? "seg" : "seg pending";
    let cursor = 0;
    for (const { start, end, flag } of markRanges(segment)) {
      span.append(segment.text.slice(cursor, start));
      const mark = document.createElement("mark");
      mark.className = flag.category;
      mark.textContent = segment.text.slice(start, end);
      mark.title = flag.name;
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.dataset.flag = flag.id;
      span.append(mark);
      cursor = end;
    }
    span.append(segment.text.slice(cursor) + " ");
    nodes.push(span);
  }

  if (state.interim) {
    const interim = document.createElement("span");
    interim.className = "interim";
    interim.textContent = state.interim;
    nodes.push(interim);
  }

  els.transcriptEmpty.hidden = nodes.length > 0;
  els.transcript.replaceChildren(els.transcriptEmpty, ...nodes);
  if (nearBottom) els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderFlags() {
  els.flagsEmpty.hidden = state.flags.length > 0;
  els.flagCount.textContent = state.flags.length ? `(${state.flags.length})` : "";

  // Newest first, so the latest flag is where the eye lands mid-conversation.
  const items = [...state.flags].reverse().map((flag) => {
    const li = document.createElement("li");
    li.className = `flag ${flag.category}`;
    li.id = `flag-${flag.id}`;

    const head = document.createElement("div");
    head.className = "flag-head";
    const name = document.createElement("span");
    name.className = "flag-name";
    name.textContent = flag.name;
    const category = document.createElement("span");
    category.className = "tag";
    category.textContent = CATEGORY_LABELS[flag.category] ?? flag.category;
    head.append(name, category);
    if (flag.confidence === "medium") {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Depends on context";
      head.append(tag);
    }

    const quote = document.createElement("blockquote");
    quote.textContent = flag.quote;

    const why = document.createElement("p");
    why.textContent = flag.explanation;

    const reply = document.createElement("p");
    reply.className = "reply";
    const label = document.createElement("span");
    label.textContent = "You could say: ";
    reply.append(label, flag.suggested_response);

    li.append(head, quote, why, reply);
    return li;
  });
  els.flags.replaceChildren(...items);
}

function focusFlag(id) {
  const card = document.getElementById(`flag-${id}`);
  if (!card) return;
  for (const el of els.flags.querySelectorAll(".focus")) el.classList.remove("focus");
  card.classList.add("focus");
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

els.transcript.addEventListener("click", (event) => {
  const mark = event.target.closest("mark");
  if (mark) focusFlag(mark.dataset.flag);
});
els.transcript.addEventListener("keydown", (event) => {
  const mark = event.target.closest("mark");
  if (mark && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    focusFlag(mark.dataset.flag);
  }
});

// ---------- Typed input ----------

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  // Pasted text can be long; split it into sentences so flags point at a specific one.
  const sentences = els.input.value.match(/[^.!?]+[.!?]*/g) ?? [];
  for (const sentence of sentences) addSegment(sentence);
  els.input.value = "";
  runNow();
});

els.example.addEventListener("click", () => {
  for (const line of EXAMPLE) addSegment(line);
  runNow();
});

function runNow() {
  clearTimeout(state.timer);
  runAnalysis(true);
}

els.clear.addEventListener("click", () => {
  clearTimeout(state.timer);
  state.segments = [];
  state.flags = [];
  state.interim = "";
  showError(null);
  render();
});

// ---------- Live speech ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function setListening(on, statusText) {
  state.listening = on;
  els.listen.textContent = on ? "Stop listening" : "Start listening";
  els.listen.classList.toggle("live", on);
  els.status.classList.toggle("live", on);
  els.status.textContent = statusText ?? (on ? "Listening" : "Not listening");
  if (!on) {
    state.interim = "";
    renderTranscript();
  }
}

if (!SpeechRecognition) {
  els.listen.disabled = true;
  els.status.textContent = "Live listening needs Chrome, Edge or Safari. You can still type below.";
} else {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) addSegment(result[0].transcript);
      else interim += result[0].transcript;
    }
    state.interim = interim;
    renderTranscript();
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setListening(false, "Microphone access was blocked. Allow it in the browser's site settings.");
    } else if (event.error === "audio-capture") {
      setListening(false, "No microphone found.");
    } else if (event.error === "network") {
      setListening(false, "Speech recognition needs an internet connection.");
    }
    // "no-speech" and "aborted" are routine; onend restarts the session.
  };

  // Browsers end a recognition session after a stretch of silence. Keep going until the user stops.
  recognition.onend = () => {
    if (!state.listening) return;
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  };

  els.listen.addEventListener("click", () => {
    if (state.listening) {
      setListening(false);
      recognition.stop();
      runNow(); // check whatever is still waiting
    } else {
      try {
        recognition.start();
        setListening(true);
      } catch {
        setListening(false, "Couldn't start listening. Try again.");
      }
    }
  });
}

render();
