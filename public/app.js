const CONTEXT_SEGMENTS = 8; // earlier segments sent along so the model can follow the argument
const DEBOUNCE_MS = 900; // wait for a pause before checking, so nearby phrases go in one request
const MIN_WORDS = 4; // don't spend a request on a fragment; it rides along with the next phrase
const MAX_BATCH = 20;

const KIND_LABELS = {
  fallacy: "Fallacy",
  pressure_tactic: "Pressure",
  statistical_red_flag: "Statistics",
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
  listenLabel: document.getElementById("listen-label"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  transcript: document.getElementById("transcript"),
  empty: document.getElementById("empty"),
  form: document.getElementById("type-form"),
  input: document.getElementById("type-input"),
  example: document.getElementById("example"),
};

const state = {
  segments: [], // { id, text, at, checked }
  flags: [], // { id, segment_id, quote, category, name, explanation, suggested_response, confidence }
  interim: "",
  nextId: 1,
  inFlight: false,
  timer: null,
  listening: false,
  startedAt: null, // when the session's clock started
  listenSince: null, // when the current listening stretch started
  shownFlags: new Set(), // flags already drawn once, so only new notes animate in
};

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function elapsed() {
  state.startedAt ??= Date.now();
  return Date.now() - state.startedAt;
}

// ---------- Analysis queue ----------

function addSegment(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return;
  state.segments.push({ id: `s${state.nextId++}`, text: clean, at: elapsed(), checked: false });
  render();
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
  render(); // show "checking…" beside the lines being sent
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Find where each of a segment's flags sits in its text.
function markRanges(segment) {
  const lower = segment.text.toLowerCase();
  const ranges = [];
  for (const flag of state.flags) {
    if (flag.segment_id !== segment.id) continue;
    const quote = flag.quote.trim().toLowerCase();
    let start = lower.indexOf(quote);
    let end = start + quote.length;
    if (start === -1 || end === start) {
      // The model's quote didn't match the text exactly: mark the whole line.
      start = 0;
      end = segment.text.length;
    }
    const overlaps = ranges.some((r) => start < r.end && end > r.start);
    ranges.push({ start, end, flag, overlaps });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function renderNote(flag) {
  const note = el("article", `note ${flag.category}`);
  if (!state.shownFlags.has(flag.id)) {
    note.classList.add("new");
    state.shownFlags.add(flag.id);
  }
  const kind = KIND_LABELS[flag.category] ?? flag.category;
  note.append(
    el("p", "kind", flag.confidence === "medium" ? `${kind} · depends on context` : kind),
    el("h3", "", flag.name),
    el("p", "why", flag.explanation),
  );
  const say = el("p", "say");
  say.append(el("span", "", "Say"), flag.suggested_response);
  note.append(say);
  return note;
}

function renderLine(segment) {
  const row = el("li", segment.checked ? "row" : "row pending");
  const said = el("p", "said");
  const notes = el("div", "notes");

  let cursor = 0;
  for (const { start, end, flag, overlaps } of markRanges(segment)) {
    notes.append(renderNote(flag));
    if (overlaps) continue; // the note still shows; the text is already marked there
    said.append(segment.text.slice(cursor, start));
    const mark = el("mark", flag.category, segment.text.slice(start, end));
    mark.title = flag.name;
    said.append(mark);
    cursor = end;
  }
  said.append(segment.text.slice(cursor));
  if (!segment.checked) notes.append(el("p", "checking", state.inFlight ? "checking…" : "waiting"));

  row.append(el("span", "t", clock(segment.at)), said, notes);
  return row;
}

function render() {
  const page = document.documentElement;
  const nearBottom = page.scrollHeight - window.scrollY - window.innerHeight < 120;

  const rows = state.segments.map(renderLine);
  if (state.interim) {
    const row = el("li", "row interim");
    row.append(el("span", "t", clock(elapsed())), el("p", "said", state.interim), el("div", "notes"));
    rows.push(row);
  }
  els.transcript.replaceChildren(...rows);
  els.empty.hidden = rows.length > 0;

  // Follow the conversation unless the reader has scrolled back up.
  if (nearBottom && rows.length) window.scrollTo({ top: page.scrollHeight });
}

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
  state.startedAt = state.listening ? Date.now() : null;
  state.shownFlags.clear();
  showError(null);
  render();
});

// ---------- Live speech ----------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

let ticker = null;

function setListening(on, statusText) {
  state.listening = on;
  els.listenLabel.textContent = on ? "Stop" : "Listen";
  els.listen.classList.toggle("live", on);
  els.status.classList.toggle("live", on);
  clearInterval(ticker);
  if (on) {
    elapsed(); // start the session clock if this is the first activity
    state.listenSince = Date.now();
    const tick = () => (els.status.textContent = `Listening ${clock(Date.now() - state.listenSince)}`);
    tick();
    ticker = setInterval(tick, 1000);
  } else {
    els.status.textContent = statusText ?? "Not listening";
    state.interim = "";
    render();
  }
}

if (!SpeechRecognition) {
  els.listen.disabled = true;
  els.status.textContent = "Listening needs Chrome, Edge or Safari. You can still type below.";
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
    render();
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
