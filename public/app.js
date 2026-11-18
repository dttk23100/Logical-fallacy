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

const HISTORY_KEY = "conversations";
const HISTORY_LIMIT = 30; // oldest saved conversations are dropped beyond this

const EXAMPLE = [
  "So I looked at the plan you sent over and I think the price is a bit high for us",
  "Honestly everyone in your industry has already signed up so you'd be the only one left behind",
  "And this price is only valid until tonight after that I can't guarantee anything",
  "Studies show that companies using this grow three hundred percent faster",
  "Well you would say that you have never run a business in your life",
  "So you are saying we should just never spend money on anything",
  "Can you send me the contract so I can read it over the weekend",
];

import { DICTIONARY } from "./dictionary.js";

const $ = (id) => document.getElementById(id);
const els = {
  mic: $("mic"),
  end: $("end"),
  status: $("status"),
  error: $("error"),
  live: $("live"),
  transcript: $("transcript"),
  empty: $("empty"),
  example: $("example"),
  typeToggle: $("type-toggle"),
  form: $("type-form"),
  input: $("type-input"),
  home: $("home"),
  remove: $("remove"),
  history: $("history"),
  historyList: $("history-list"),
  historyOpen: $("history-open"),
  summary: $("summary"),
  summaryBody: $("summary-body"),
  back: $("back"),
  fresh: $("fresh"),
  dictionary: $("dictionary"),
  dictionaryList: $("dictionary-list"),
  dictionaryOpen: $("dictionary-open"),
  search: $("dictionary-search"),
};

const state = {
  segments: [], // { id, text, at, checked, speaker, confirmed }
  flags: [], // { id, segment_id, quote, category, name, explanation, confidence }
  interim: "",
  nextId: 1,
  inFlight: false,
  timer: null,
  listening: false,
  view: "live", // "live", "summary", "history" or "dictionary"
  viewing: null, // a saved conversation open in the summary view, or null for the current one
  conversationId: null, // set when the first words arrive
  startedOn: null, // wall-clock time the conversation began
  startedAt: null, // when the conversation's clock started
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
  state.conversationId ??= `c${Date.now()}`;
  state.startedOn ??= Date.now();
  state.segments.push({ id: `s${state.nextId++}`, text: clean, at: elapsed(), checked: false });
  render();
  scheduleAnalysis();
}

function scheduleAnalysis(delay = DEBOUNCE_MS) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => runAnalysis(false), delay);
}

function runNow() {
  clearTimeout(state.timer);
  runAnalysis(true);
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
  let failed = false;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: context.map(toWire), segments: batch.map(toWire) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Analysis failed (${res.status}).`);

    const lines = new Map((body.lines ?? []).map((line) => [line.segment_id, line]));
    for (const segment of batch) {
      segment.checked = true;
      const line = lines.get(segment.id);
      if (!line) continue;
      // A label the listener set while the request was running wins over the guess.
      if (!segment.confirmed && SPEAKERS.includes(line.speaker)) segment.speaker = line.speaker;
      // Take the repaired wording, unless it strays far from what was heard.
      const repaired = String(line.text ?? "").trim();
      const ratio = repaired.length / segment.text.length;
      if (repaired && ratio > 0.6 && ratio < 1.6) segment.text = repaired;
    }
    for (const flag of body.flags ?? []) {
      state.flags.push({ ...flag, id: `f${state.flags.length + 1}` });
    }
    showError(null);
  } catch (error) {
    // Leave the batch unchecked; it is retried with the next phrase that arrives.
    failed = true;
    showError(error instanceof TypeError ? "Can't reach the server." : error.message);
  } finally {
    state.inFlight = false;
    saveCurrent();
    render();
    // After a failure, wait for new speech before trying again.
    if (!failed && state.segments.some((s) => !s.checked)) scheduleAnalysis(0);
  }
}

// ---------- Rendering: live conversation ----------

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

function kindLine(flag, speaker) {
  const parts = [KIND_LABELS[flag.category] ?? flag.category];
  if (speaker) parts.push(speaker);
  if (flag.confidence === "medium") parts.push("borderline");
  return parts.join(" · ");
}

function renderNote(flag, speaker) {
  const note = el("div", flag.confidence === "medium" ? "note borderline" : "note");
  if (!state.shownFlags.has(flag.id)) {
    note.classList.add("new");
    state.shownFlags.add(flag.id);
  }
  note.append(el("p", "kind", kindLine(flag, speaker)), el("h3", "name", flag.name), el("p", "why", flag.explanation));
  return note;
}

// Lines arrive one pause at a time. Once checked, consecutive lines from the same
// speaker are shown as one turn so the conversation reads cleanly.
function groupTurns(segments = state.segments) {
  const turns = [];
  for (const segment of segments) {
    const last = turns.at(-1);
    const joins = last && last.checked && segment.checked && segment.speaker && last.speaker === segment.speaker;
    if (joins) last.segments.push(segment);
    else turns.push({ speaker: segment.speaker, checked: segment.checked, segments: [segment] });
  }
  return turns;
}

function renderTurn(turn) {
  const item = el("li", turn.checked ? "turn" : "turn pending");
  const line = el("p", "line");
  const notes = [];

  if (turn.speaker) {
    const who = el("button", "who", turn.speaker);
    who.type = "button";
    who.dataset.segment = turn.segments[0].id;
    who.title = "Wrong speaker? Tap to change";
    who.setAttribute("aria-label", `Speaker ${turn.speaker}. Change speaker`);
    line.append(who);
  }

  for (const segment of turn.segments) {
    let cursor = 0;
    for (const { start, end, flag, overlaps } of markRanges(segment)) {
      notes.push(renderNote(flag, segment.speaker));
      if (overlaps) continue; // the note still shows; the text is already marked there
      line.append(segment.text.slice(cursor, start));
      line.append(el("mark", "", segment.text.slice(start, end)));
      cursor = end;
    }
    line.append(segment.text.slice(cursor) + " ");
  }

  item.append(line, ...notes);
  return item;
}

function renderLive() {
  const page = document.documentElement;
  const nearBottom = page.scrollHeight - window.scrollY - window.innerHeight < 160;

  const items = groupTurns().map(renderTurn);
  if (state.interim) {
    const item = el("li", "turn interim");
    item.append(el("p", "line", state.interim));
    items.push(item);
  }
  els.transcript.replaceChildren(...items);
  els.empty.hidden = items.length > 0;

  // Follow the conversation unless the reader has scrolled back up.
  if (nearBottom && items.length) window.scrollTo({ top: page.scrollHeight });
}

// ---------- Rendering: summary ----------

function plural(n, word) {
  return n === 1 ? `1 ${word}` : `${n} ${word === "fallacy" ? "fallacies" : word + "s"}`;
}

function renderSummary() {
  const saved = state.viewing;
  const { segments, flags } = saved ?? state;
  const bySegment = new Map(segments.map((s) => [s.id, s]));
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))].sort();
  const entries = flags.map((flag) => {
    const segment = bySegment.get(flag.segment_id);
    return { flag, at: segment?.at ?? 0, speaker: segment?.speaker ?? "?" };
  });
  if (entries.some((e) => e.speaker === "?")) speakers.push("?");
  const label = (speaker) => (speaker === "?" ? "Unknown speaker" : `Speaker ${speaker}`);
  const length = segments.at(-1)?.at ?? 0;

  const nodes = [
    el("p", "sum-meta", saved ? `${dateLabel(saved.startedOn)} · ${clock(length)}` : `Conversation · ${clock(length)}`),
    el("h2", "sum-title", entries.length ? plural(entries.length, "fallacy") : "No fallacies"),
  ];
  if (!saved && segments.some((s) => !s.checked)) {
    nodes.push(el("p", "sum-note", els.error.hidden ? "Still checking the last lines…" : "The last lines could not be checked."));
  }

  if (speakers.length) {
    const tally = el("ul", "tally");
    for (const speaker of speakers) {
      const row = el("li");
      row.append(el("span", "", label(speaker)), el("b", "", String(entries.filter((e) => e.speaker === speaker).length)));
      tally.append(row);
    }
    nodes.push(tally);
  }

  for (const speaker of speakers) {
    const mine = entries.filter((e) => e.speaker === speaker);
    if (!mine.length) continue;
    const list = el("ol", "entries");
    for (const { flag, at } of mine) {
      const item = el("li");
      item.append(
        el("p", "kind", `${clock(at)} · ${kindLine(flag)}`),
        el("h3", "name", flag.name),
        el("p", "why", flag.explanation),
        el("q", "", flag.quote.trim()),
      );
      list.append(item);
    }
    nodes.push(el("h3", "sum-speaker", label(speaker)), list);
  }

  // The full conversation, for reading back.
  if (segments.length) {
    const script = el("div", "script");
    for (const turn of groupTurns(segments.map((s) => ({ ...s, checked: true })))) {
      const line = el("p", "line");
      if (turn.speaker) line.append(el("span", "who", turn.speaker));
      line.append(turn.segments.map((s) => s.text).join(" "));
      script.append(line);
    }
    nodes.push(el("h3", "sum-speaker", "Transcript"), script);
  }
  els.summaryBody.replaceChildren(...nodes);

  els.back.textContent = saved ? "Back to history" : "Back to conversation";
  els.fresh.hidden = Boolean(saved);
  els.remove.hidden = !saved;
  els.remove.textContent = "Delete";
}

// ---------- History: conversations saved on this device ----------

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // storage unavailable or corrupted: carry on without history
  }
}

function storeHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    // Private windows and full storage refuse writes; the conversation still works.
  }
}

// Keep the conversation in progress saved, so closing the page doesn't lose it.
function saveCurrent() {
  if (!state.conversationId || !state.segments.length) return;
  const record = {
    id: state.conversationId,
    startedOn: state.startedOn,
    segments: state.segments.map(({ id, text, at, speaker }) => ({ id, text, at, speaker })),
    flags: state.flags,
  };
  storeHistory([record, ...loadHistory().filter((c) => c.id !== record.id)]);
}

function dateLabel(time) {
  return new Date(time).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function renderHistory() {
  const list = loadHistory();
  const items = list.map((conversation) => {
    const item = el("li");
    const open = el("button", "open");
    open.type = "button";
    open.dataset.id = conversation.id;
    const length = conversation.segments.at(-1)?.at ?? 0;
    const current = conversation.id === state.conversationId ? " · in progress" : "";
    open.append(
      el("p", "kind", `${dateLabel(conversation.startedOn)} · ${clock(length)}${current}`),
      el("h3", "name", conversation.flags.length ? plural(conversation.flags.length, "fallacy") : "No fallacies"),
      el("p", "snippet", conversation.segments.map((s) => s.text).join(" ")),
    );
    item.append(open);
    return item;
  });
  if (!items.length) items.push(el("li", "sum-note", "No conversations yet. They are saved here as you talk."));
  els.historyList.replaceChildren(...items);
}

// ---------- Rendering: dictionary ----------

function renderDictionary() {
  const query = els.search.value.trim().toLowerCase();
  const nodes = [];
  for (const { group, entries } of DICTIONARY) {
    const matches = entries.filter(([name, text]) => `${name} ${text}`.toLowerCase().includes(query));
    if (!matches.length) continue;
    const list = el("ul", "entries");
    for (const [name, text] of matches) {
      const item = el("li");
      item.append(el("h3", "name", name), el("p", "why", text));
      list.append(item);
    }
    nodes.push(el("h3", "sum-speaker", group), list);
  }
  if (!nodes.length) nodes.push(el("p", "sum-note", "Nothing matches that search."));
  els.dictionaryList.replaceChildren(...nodes);
}

function render() {
  document.body.dataset.view = state.view;
  els.live.hidden = state.view !== "live";
  els.summary.hidden = state.view !== "summary";
  els.history.hidden = state.view !== "history";
  els.dictionary.hidden = state.view !== "dictionary";
  for (const [button, view] of [[els.historyOpen, "history"], [els.dictionaryOpen, "dictionary"]]) {
    if (state.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  els.end.disabled = state.segments.length === 0 && !state.interim;
  if (state.view === "summary") renderSummary();
  else if (state.view === "live") renderLive();
}

function show(view, viewing = null) {
  state.view = view;
  state.viewing = viewing;
  if (view === "history") renderHistory();
  if (view === "dictionary") {
    els.search.value = "";
    renderDictionary();
  }
  render();
  // The live view opens at the newest words; everything else at the top.
  window.scrollTo({ top: view === "live" ? document.documentElement.scrollHeight : 0 });
}

// ---------- Controls ----------

// Tapping a speaker label moves that whole turn to the next speaker. The correction is
// sent with later requests, so the model keeps its labels consistent with it.
els.transcript.addEventListener("click", (event) => {
  const who = event.target.closest(".who");
  if (!who) return;
  const turn = groupTurns().find((t) => t.segments[0].id === who.dataset.segment);
  if (!turn) return;
  // Offer the speakers on the other lines plus one new one, so repeated taps come back round.
  const others = state.segments
    .filter((s) => !turn.segments.includes(s) && s.speaker)
    .map((s) => SPEAKERS.indexOf(s.speaker));
  const choices = SPEAKERS.slice(0, Math.min(SPEAKERS.length, Math.max(2, Math.max(-1, ...others) + 2)));
  const next = choices[(choices.indexOf(turn.speaker) + 1) % choices.length];
  for (const segment of turn.segments) {
    segment.speaker = next;
    segment.confirmed = true;
  }
  saveCurrent();
  render();
});

els.typeToggle.addEventListener("click", () => {
  els.form.hidden = !els.form.hidden;
  if (!els.form.hidden) els.input.focus();
});

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

els.home.addEventListener("click", () => show("live"));
els.historyOpen.addEventListener("click", () => show("history"));
els.dictionaryOpen.addEventListener("click", () => show("dictionary"));
els.search.addEventListener("input", renderDictionary);

els.historyList.addEventListener("click", (event) => {
  const open = event.target.closest(".open");
  const conversation = open && loadHistory().find((c) => c.id === open.dataset.id);
  if (conversation) show("summary", conversation);
});

els.end.addEventListener("click", () => {
  if (state.listening) {
    setListening(false);
    recognition.stop(); // onend takes the last words and checks them
  } else {
    runNow();
  }
  saveCurrent();
  show("summary");
});

els.back.addEventListener("click", () => show(state.viewing ? "history" : "live"));

// Deleting takes two taps, since it can't be undone.
els.remove.addEventListener("click", () => {
  if (els.remove.textContent === "Delete") {
    els.remove.textContent = "Tap again to delete";
    return;
  }
  const id = state.viewing?.id;
  storeHistory(loadHistory().filter((c) => c.id !== id));
  if (id === state.conversationId) resetConversation();
  show("history");
});

function resetConversation() {
  clearTimeout(state.timer);
  for (let i = 0; i < heard.length; i++) taken[i] = heard[i].length; // don't bring old words back
  state.segments = [];
  state.flags = [];
  state.interim = "";
  state.startedAt = null;
  state.conversationId = null;
  state.startedOn = null;
  state.shownFlags.clear();
  showError(null);
}

els.fresh.addEventListener("click", () => {
  saveCurrent();
  resetConversation();
  show("live");
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
  els.mic.classList.toggle("live", on);
  els.mic.setAttribute("aria-label", on ? "Stop listening" : "Start listening");
  clearInterval(ticker);
  if (on) {
    elapsed(); // start the conversation clock if this is the first activity
    state.listenSince = Date.now();
    const tick = () => (els.status.textContent = `Listening ${clock(Date.now() - state.listenSince)}`);
    tick();
    ticker = setInterval(tick, 1000);
  } else {
    els.status.textContent = statusText ?? "Tap to listen";
  }
}

if (!SpeechRecognition) {
  els.mic.disabled = true;
  els.form.hidden = false;
  els.status.textContent = "Listening needs Chrome, Edge or Safari";
} else {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

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
      setListening(false, "Microphone blocked. Allow it in site settings");
    } else if (event.error === "audio-capture") {
      setListening(false, "No microphone found");
    } else if (event.error === "network") {
      setListening(false, "Speech recognition needs internet");
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

  els.mic.addEventListener("click", () => {
    if (state.listening) {
      setListening(false);
      recognition.stop();
    } else {
      try {
        newSession();
        recognition.start();
        setListening(true);
      } catch {
        setListening(false, "Couldn't start listening. Try again");
      }
    }
  });
}

render();
