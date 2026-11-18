const CONTEXT_SEGMENTS = 8; // earlier segments sent along so the model can follow the argument
const DEBOUNCE_MS = 900; // wait for a pause before checking, so nearby phrases go in one request
const MIN_WORDS = 4; // don't spend a request on a fragment; it rides along with the next phrase
const MAX_BATCH = 20;

// Browsers differ in when they call a phrase finished. Some wait for a long pause and some
// (Safari, iPhone) never do until listening stops, so the page decides for itself:
const STABLE_MS = 1500; // words unchanged for this long become a transcript line
const FINISHED_MS = 300; // shorter wait when the browser says the phrase is finished
const MAX_PENDING_WORDS = 28; // nonstop speech is cut into lines of about this length
const VOLATILE_WORDS = 4; // the newest words can still be revised, so a cut leaves them out

const KIND_LABELS = {
  fallacy: "Fallacy",
  pressure_tactic: "Pressure",
  statistical_red_flag: "Statistics",
};

const SPEAKERS = ["A", "B", "C", "D", "E", "F"];

const LANGUAGES = [
  ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["de-DE", "Deutsch"], ["es-ES", "Español"],
  ["fr-FR", "Français"], ["it-IT", "Italiano"], ["pt-BR", "Português"], ["nl-NL", "Nederlands"],
  ["pl-PL", "Polski"], ["tr-TR", "Türkçe"], ["vi-VN", "Tiếng Việt"], ["hi-IN", "हिन्दी"],
  ["ja-JP", "日本語"], ["ko-KR", "한국어"], ["zh-CN", "中文"],
];

const EXAMPLE = [
  "So I looked at the plan you sent over and I think the price is a bit high for us",
  "Honestly everyone in your industry has already signed up so you'd be the only one left behind",
  "And this price is only valid until tonight after that I can't guarantee anything",
  "Studies show that companies using this grow three hundred percent faster",
  "Well you would say that you have never run a business in your life",
  "So you are saying we should just never spend money on anything",
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
  language: document.getElementById("language"),
};

const state = {
  segments: [], // { id, text, at, checked, speaker, confirmed }
  flags: [], // { id, segment_id, quote, category, name, explanation, confidence }
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
  const toWire = (s) => ({
    id: s.id,
    text: s.text,
    speaker: s.speaker,
    confirmed: s.confirmed,
    // Lets the model see what it already raised, so a continued sentence isn't flagged twice.
    flagged: state.flags.filter((f) => f.segment_id === s.id).map((f) => f.name),
  });

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

    const guesses = new Map((body.speakers ?? []).map((g) => [g.segment_id, g.speaker]));
    for (const segment of batch) {
      segment.checked = true;
      // A label the listener set while the request was running wins over the guess.
      if (!segment.confirmed && SPEAKERS.includes(guesses.get(segment.id))) {
        segment.speaker = guesses.get(segment.id);
      }
    }
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

function renderNote(flag, speaker) {
  const note = el("article", `note ${flag.category}`);
  if (!state.shownFlags.has(flag.id)) {
    note.classList.add("new");
    state.shownFlags.add(flag.id);
  }
  const kind = [KIND_LABELS[flag.category] ?? flag.category];
  if (speaker) kind.push(`by ${speaker}`);
  if (flag.confidence === "medium") kind.push("borderline");
  note.append(
    el("p", "kind", kind.join(" · ")),
    el("h3", "", flag.name),
    el("p", "why", flag.explanation),
  );
  return note;
}

function renderLine(segment, previous) {
  const row = el("li", segment.checked ? "row" : "row pending");
  const said = el("p", "said");
  const notes = el("div", "notes");

  if (segment.speaker) {
    // A new turn gets some air above it, like a change of speaker in a script.
    if (previous?.speaker && previous.speaker !== segment.speaker) row.classList.add("turn");
    const who = el("button", "who", segment.speaker);
    who.type = "button";
    who.dataset.segment = segment.id;
    who.title = "Wrong speaker? Click to change";
    who.setAttribute("aria-label", `Speaker ${segment.speaker}. Change speaker`);
    said.append(who);
  }

  let cursor = 0;
  for (const { start, end, flag, overlaps } of markRanges(segment)) {
    notes.append(renderNote(flag, segment.speaker));
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

  const rows = state.segments.map((segment, i) => renderLine(segment, state.segments[i - 1]));
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

// Clicking a speaker label moves that line to the next speaker. The correction is sent
// with later requests, so the model keeps its labels consistent with it.
els.transcript.addEventListener("click", (event) => {
  const who = event.target.closest(".who");
  if (!who) return;
  const segment = state.segments.find((s) => s.id === who.dataset.segment);
  if (!segment) return;
  // Offer the speakers on the other lines plus one new one, so repeated clicks come back round.
  const others = state.segments.filter((s) => s !== segment && s.speaker).map((s) => SPEAKERS.indexOf(s.speaker));
  const choices = SPEAKERS.slice(0, Math.min(SPEAKERS.length, Math.max(2, Math.max(-1, ...others) + 2)));
  segment.speaker = choices[(choices.indexOf(segment.speaker) + 1) % choices.length];
  segment.confirmed = true;
  render();
  els.transcript.querySelector(`.who[data-segment="${segment.id}"]`)?.focus();
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
  for (let i = 0; i < heard.length; i++) taken[i] = heard[i].length; // don't bring cleared words back
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

// Words from the current recognition session. heard[i] is the latest wording of the i-th
// phrase; taken[i] counts how many of its words are already in the transcript.
let heard = [];
let finished = [];
let taken = [];
let stableTimer = null;

function newSession() {
  clearTimeout(stableTimer);
  heard = [];
  finished = [];
  taken = [];
}

function pendingWords() {
  return heard.flatMap((words, i) => words.slice(taken[i] ?? 0));
}

// Move pending words from phrases 0..through into the transcript as one line,
// leaving the last `keep` words of that last phrase for later.
function takeWords(through, keep) {
  const line = [];
  for (let i = 0; i <= through && i < heard.length; i++) {
    const from = taken[i] ?? 0;
    const upto = i === through ? Math.max(from, heard[i].length - keep) : heard[i].length;
    line.push(...heard[i].slice(from, upto));
    taken[i] = upto;
  }
  if (line.length) addSegment(line.join(" "));
}

function showPending() {
  state.interim = pendingWords().join(" ");
  render();
}

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
  }
}

// The recogniser must be told which language to expect; the wrong one garbles everything.
function storedLanguage() {
  try {
    return localStorage.getItem("language");
  } catch {
    return null;
  }
}
const browserLanguage = LANGUAGES.find(([code]) => code === navigator.language)?.[0];
for (const [code, name] of LANGUAGES) els.language.append(new Option(name, code));
els.language.value = LANGUAGES.some(([code]) => code === storedLanguage())
  ? storedLanguage()
  : (browserLanguage ?? "en-US");

if (!SpeechRecognition) {
  els.listen.disabled = true;
  els.language.disabled = true;
  els.status.textContent = "Listening needs Chrome, Edge or Safari. You can still type below.";
} else {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = els.language.value;

  els.language.addEventListener("change", () => {
    recognition.lang = els.language.value;
    try {
      localStorage.setItem("language", els.language.value);
    } catch {
      // Storage can be unavailable; the choice still applies to this visit.
    }
    if (state.listening) recognition.stop(); // onend restarts it in the new language
  });

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const words = event.results[i][0].transcript.trim().split(/\s+/).filter(Boolean);
      const done = taken[i] ?? 0;
      // The recogniser may revise a phrase. A small shrink is a correction; a big one is new speech.
      if (words.length < done - 2) taken[i] = 0;
      else if (words.length < done) taken[i] = words.length;
      heard[i] = words;
      finished[i] = event.results[i].isFinal;
    }
    heard.length = finished.length = event.results.length;
    const last = heard.length - 1;

    // A finished phrase with another one after it can no longer change.
    const settled = last > 0 ? finished.lastIndexOf(true, last - 1) : -1;
    if (settled >= 0) takeWords(settled, 0);
    if (pendingWords().length >= MAX_PENDING_WORDS) takeWords(last, VOLATILE_WORDS);
    showPending();

    // The newest phrase is taken once it stops changing. Android marks every update as
    // finished and then keeps extending it, so even a finished phrase gets a short wait.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      takeWords(heard.length - 1, 0);
      showPending();
    }, finished[last] ? FINISHED_MS : STABLE_MS);
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
    // A session can end before it confirms the words it was still working on. Keep them.
    takeWords(heard.length - 1, 0);
    newSession();
    showPending();
    if (!state.listening) {
      runNow(); // check whatever is still waiting
      return;
    }
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
    } else {
      try {
        newSession();
        recognition.start();
        setListening(true);
      } catch {
        setListening(false, "Couldn't start listening. Try again.");
      }
    }
  });
}

render();
