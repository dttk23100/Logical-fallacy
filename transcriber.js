// Speech-to-text through Groq's hosted Whisper. Used when GROQ_API_KEY is set;
// without it the page falls back to the browser's own speech recognition.
const BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const MODEL = process.env.WHISPER_MODEL || "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // a few seconds of compressed speech is far below this

const EXTENSIONS = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };

export function whisperAvailable() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Transcribes one audio clip. `prompt` is the tail of the transcript so far, which helps
// Whisper keep names and wording consistent from one clip to the next.
export async function transcribe(audio, type, prompt) {
  if (!whisperAvailable()) return { status: 501, body: { error: "Whisper is not set up. Add GROQ_API_KEY." } };
  const mime = String(type ?? "").split(";")[0];
  const extension = EXTENSIONS[mime];
  if (!extension) return { status: 400, body: { error: "Unsupported audio type" } };
  if (!audio?.length) return { status: 400, body: { error: "No audio received" } };
  if (audio.length > MAX_AUDIO_BYTES) return { status: 413, body: { error: "Audio clip too large" } };

  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), `clip.${extension}`);
  form.append("model", MODEL);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  if (prompt) form.append("prompt", String(prompt).slice(-300));

  let response;
  try {
    response = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
  } catch (error) {
    console.error("Whisper request failed:", error);
    return { status: 502, body: { error: "Couldn't reach the transcription service." } };
  }

  if (response.status === 401) return { status: 401, body: { error: "The Groq API key is invalid." } };
  if (response.status === 429) return { status: 429, body: { error: "Transcription limit reached. Try again shortly." } };
  if (!response.ok) {
    console.error("Whisper error:", response.status, await response.text().catch(() => ""));
    return { status: 502, body: { error: `Transcription failed (${response.status}).` } };
  }

  const result = await response.json();
  // Whisper invents words for silence and noise. Keep only the parts it believes are speech.
  const spoken = Array.isArray(result.segments)
    ? result.segments.filter((s) => (s.no_speech_prob ?? 0) < 0.6).map((s) => s.text).join(" ")
    : result.text;
  return { status: 200, body: { text: String(spoken ?? "").replace(/\s+/g, " ").trim() } };
}
