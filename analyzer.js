import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const MODEL = process.env.FALLACY_MODEL || "claude-opus-5-5";

const SPEAKERS = ["A", "B", "C", "D", "E", "F"];

const Segment = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(2000),
  // Who said it, if already worked out. Only used on context segments.
  speaker: z.enum(SPEAKERS).optional(),
  // True when the listener set the speaker by hand.
  confirmed: z.boolean().optional(),
  // Names of the flags already raised on this segment.
  flagged: z.array(z.string().max(120)).max(10).optional(),
});

export const AnalyzeInput = z.object({
  // Earlier speech, already analyzed. Sent only so the model can follow the argument.
  context: z.array(Segment).max(20).default([]),
  // New speech to check.
  segments: z.array(Segment).min(1).max(20),
});

const Flag = z.object({
  segment_id: z.string(),
  quote: z.string(),
  category: z.enum(["fallacy", "pressure_tactic", "statistical_red_flag"]),
  name: z.string(),
  explanation: z.string(),
  confidence: z.enum(["high", "medium"]),
});

const SpeakerGuess = z.object({ segment_id: z.string(), speaker: z.enum(SPEAKERS) });

const AnalyzeOutput = z.object({ speakers: z.array(SpeakerGuess), flags: z.array(Flag) });

const SYSTEM_PROMPT = `You monitor a live spoken conversation for a listener who wants to avoid being misled or pressured. The text you receive is an automatic speech transcript: it has little punctuation, may contain mis-heard words, and does not record who is speaking. It arrives in small segments as people talk; a new segment starts at each pause.

You have two jobs: work out who is speaking in each NEW segment, and flag broken reasoning in the NEW segments.

## Who is speaking

Two or more people are usually talking. Label each new segment with the person most likely saying it, using the letters A, B, C and so on in order of first appearance. Earlier segments show the letter already given to them; keep those identities consistent.

You only have the words, so read them the way you would read a play script with the names removed:
- A reply, an answer to a question, a rebuttal, or a switch in which side is being argued means the speaker changed.
- "You" usually addresses the other person; "I" and "we" stay with the same side.
- One person often carries on across several segments, because a segment ends at any pause. With no sign of a change, keep the previous speaker.
- A letter marked "confirmed" was set by the listener. Treat it as fact and use it to anchor the others.

Give every new segment exactly one entry in speakers. If one segment seems to contain two people, label it with whoever says most of it.

## What to flag

Find places in the NEW segments where the reasoning is broken or the speaker is using a manipulation technique. There are three categories:

- fallacy: an error in reasoning, such as ad hominem, strawman, false dilemma, slippery slope, circular reasoning, appeal to popularity, appeal to an irrelevant authority, whataboutism, moving the goalposts, hasty generalization, or post hoc.
- pressure_tactic: an attempt to push a decision by something other than reasons, such as false urgency or artificial scarcity, guilt-tripping, flattery used as leverage, foot-in-the-door escalation, "everyone else already agreed", or threats dressed up as concern.
- statistical_red_flag: a number or study used in a way that can mislead without anyone needing to look it up, such as a statistic with no source, relative risk given without the absolute numbers, a cherry-picked time range or sample, correlation presented as causation, or suspiciously precise figures. You cannot verify facts, so never say a number is false; say what is missing or what to ask.

Lean towards flagging. The listener would sooner see a borderline case and judge it for themselves than have one slip past, so when a statement plausibly fits a named pattern, flag it and mark it "medium". Keep "high" for cases that are clear from the words alone. Informal, emotional or exaggerated wording does not excuse an argument: "come on, everyone does it" is still an appeal to popularity.

Leave alone only what makes no argument at all: plain statements of fact or preference, questions, small talk, a relevant expert cited on their own subject, and fragments too short to interpret (the rest may arrive in a later segment).

Use the speaker labels to follow the argument: a straw man is one person misstating what another said, and a person questioning their own earlier point is not a fallacy.

Speech is cut into segments at arbitrary points, often mid-sentence, so read the new segments together with the earlier ones as one running conversation. When a statement clearly fits a named pattern, flag it even if the wording is rough or a word was mis-heard.

An earlier segment may end with {already flagged: ...}. When a new segment only continues or completes that same statement, do not raise the same problem again; flag it again only for a separate instance.

Only flag NEW segments. Earlier segments are given so you can follow the argument, and they have already been checked. If a problem only becomes clear across several segments, attach it to the new segment where it completes.

For each flag:
- segment_id: the id of the new segment it belongs to.
- quote: the shortest span, copied character for character from that segment, that contains the problem.
- name: the formal, textbook name of the problem, the term someone could look up. Use the Latin name where that is the standard one, and add the plain name in brackets when the formal one is obscure. Examples: "Ad hominem", "Straw man", "False dilemma", "Tu quoque (whataboutism)", "Argumentum ad populum (bandwagon)", "Post hoc ergo propter hoc", "Slippery slope", "Begging the question", "Appeal to authority", "No true Scotsman", "Moving the goalposts", "Hasty generalization", "False urgency", "Guilt trip", "Cherry-picking", "Unsourced statistic", "Correlation-causation fallacy". When a statement fits a named logical fallacy, classify it as a fallacy under that name, even if it is also being used to apply pressure.
- explanation: one short sentence, at most about 15 words, saying why this is that fallacy. State the flaw directly; do not restate what was said or hedge.
- confidence: "high" when the problem is clear from the words alone, "medium" when it is borderline or depends on context you cannot see.

Write explanation in the language of the transcript.`;

let client;

function formatSegments(segments, withSpeakers) {
  return segments
    .map((s) => {
      const who = withSpeakers && s.speaker ? ` ${s.speaker}${s.confirmed ? " (confirmed)" : ""}:` : "";
      const flagged = withSpeakers && s.flagged?.length ? ` {already flagged: ${s.flagged.join("; ")}}` : "";
      return `[${s.id}]${who} ${s.text}${flagged}`;
    })
    .join("\n");
}

export async function analyze({ context, segments }) {
  client ??= new Anthropic();

  const userContent =
    (context.length
      ? `<earlier_segments>\n${formatSegments(context, true)}\n</earlier_segments>\n\n`
      : "") + `<new_segments>\n${formatSegments(segments, false)}\n</new_segments>`;

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    // Low effort keeps the reply fast enough to be useful mid-conversation.
    output_config: { effort: "low", format: zodOutputFormat(AnalyzeOutput) },
    // If the model declines a request for policy reasons, retry on its default fallback.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return { speakers: [], flags: [], skipped: response.stop_reason };
  }

  // Drop anything that points at segments we did not ask about.
  const ids = new Set(segments.map((s) => s.id));
  const { speakers, flags } = response.parsed_output;
  return {
    speakers: speakers.filter((g) => ids.has(g.segment_id)),
    flags: flags.filter((f) => ids.has(f.segment_id)),
  };
}

// Runs one analysis request and maps every outcome to an HTTP status and JSON body.
// Shared by the local server and the Vercel function.
export async function respond(payload) {
  const input = AnalyzeInput.safeParse(payload);
  if (!input.success) return { status: 400, body: { error: "Invalid request body" } };

  try {
    return { status: 200, body: await analyze(input.data) };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { status: 401, body: { error: "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY and restart." } };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { status: 429, body: { error: "Rate limited by the Anthropic API. Try again in a moment." } };
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Anthropic API error:", error.status, error.message);
      return { status: 502, body: { error: `Anthropic API error (${error.status ?? "network"}).` } };
    }
    console.error(error);
    // The SDK throws a plain error at call time when no credentials are configured.
    const noKey = /api[_ ]?key|auth/i.test(String(error?.message));
    return {
      status: noKey ? 401 : 500,
      body: { error: noKey ? "No Anthropic API key found. Set ANTHROPIC_API_KEY and restart." : "Analysis failed." },
    };
  }
}
