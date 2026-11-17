import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const MODEL = process.env.FALLACY_MODEL || "claude-opus-5-5";

const Segment = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(2000),
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
  suggested_response: z.string(),
  confidence: z.enum(["high", "medium"]),
});

const AnalyzeOutput = z.object({ flags: z.array(Flag) });

const SYSTEM_PROMPT = `You monitor a live spoken conversation for a listener who wants to avoid being misled or pressured. The text you receive is an automatic speech transcript: it has no speaker labels, little punctuation, and may contain mis-heard words. It arrives in small segments as people talk.

Find places in the NEW segments where the reasoning is broken or the speaker is using a manipulation technique. There are three categories:

- fallacy: an error in reasoning, such as ad hominem, strawman, false dilemma, slippery slope, circular reasoning, appeal to popularity, appeal to an irrelevant authority, whataboutism, moving the goalposts, hasty generalization, or post hoc.
- pressure_tactic: an attempt to push a decision by something other than reasons, such as false urgency or artificial scarcity, guilt-tripping, flattery used as leverage, foot-in-the-door escalation, "everyone else already agreed", or threats dressed up as concern.
- statistical_red_flag: a number or study used in a way that can mislead without anyone needing to look it up, such as a statistic with no source, relative risk given without the absolute numbers, a cherry-picked time range or sample, correlation presented as causation, or suspiciously precise figures. You cannot verify facts, so never say a number is false; say what is missing or what to ask.

Most everyday speech contains none of these. The listener will stop trusting the tool if it flags ordinary talk, so a wrong flag costs more than a missed one. Return an empty list unless you are confident. In particular, do not flag:
- opinions, preferences, jokes, exaggeration for effect, or emotional expression that is not standing in for an argument
- citing a relevant expert, or popularity where popularity is actually the point
- real deadlines and real constraints stated plainly
- fragments too short or too garbled to interpret; the rest of the sentence may arrive in a later segment

Only flag NEW segments. Earlier segments are given so you can follow the argument, and they have already been checked. If a problem only becomes clear across several segments, attach it to the new segment where it completes.

For each flag:
- segment_id: the id of the new segment it belongs to.
- quote: the shortest span, copied character for character from that segment, that contains the problem.
- name: the common plain name, for example "False dilemma" or "False urgency".
- explanation: one sentence, in plain words, saying what is wrong with this specific statement. The listener reads it at a glance mid-conversation.
- suggested_response: one short thing the listener could say or ask next, calm and non-accusatory, that does not name the fallacy.
- confidence: "high" when the problem is clear from the words alone, "medium" when it depends on context you cannot see.

Write explanation and suggested_response in the language of the transcript.`;

let client;

function formatSegments(segments) {
  return segments.map((s) => `[${s.id}] ${s.text}`).join("\n");
}

export async function analyze({ context, segments }) {
  client ??= new Anthropic();

  const userContent =
    (context.length
      ? `<earlier_segments>\n${formatSegments(context)}\n</earlier_segments>\n\n`
      : "") + `<new_segments>\n${formatSegments(segments)}\n</new_segments>`;

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
    return { flags: [], skipped: response.stop_reason };
  }

  // Drop flags that point at segments we did not ask about.
  const ids = new Set(segments.map((s) => s.id));
  return { flags: response.parsed_output.flags.filter((f) => ids.has(f.segment_id)) };
}
