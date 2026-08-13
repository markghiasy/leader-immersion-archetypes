import Anthropic from "@anthropic-ai/sdk";
import { OPTIONS_PER_QUESTION, questions } from "@/lib/scoring";
import type { Extraction } from "./controller";

/**
 * THE REAL EXTRACTOR — the only part of the interview that calls a model.
 *
 * It does exactly one job: given the questions still open and what the person just said,
 * decide which option each answered question maps to. It is handed question and option
 * TEXT only — never the option→profile mappings, never the archetypes, never the scores.
 * The seam from lib/interview/controller.ts holds here.
 *
 * Two design choices worth not undoing:
 *
 *   1. It reports a categorical CERTAINTY, not a number. Models are poorly calibrated when
 *      asked to emit a probability, but reliably distinguish "they said this outright" from
 *      "this is a stretch". The controller's confidence threshold then does real work
 *      instead of filtering noise.
 *   2. It returns the QUOTE that drove each answer. That is the audit trail for "why did I
 *      get this archetype?", the material for a grounded post-result conversation, and the
 *      first thing to look at when a mapping is wrong.
 *
 * It abstains by design: a question the person did not actually address is omitted, not
 * guessed. One wrong answer out of 25 changes the archetype 15.4% of the time, so an
 * omission (which the controller will simply ask about) is far cheaper than a guess.
 */

export type Certainty = "explicit" | "implied" | "inferred";

/**
 * Certainty → the controller's 0-1 confidence scale. `inferred` deliberately lands below
 * the default 0.75 threshold so a stretch always triggers a confirming question.
 */
const CONFIDENCE: Record<Certainty, number> = {
  explicit: 0.95,
  implied: 0.82,
  inferred: 0.55,
};

export type ExtractorConfig = {
  model: string;
  /**
   * Omit for models that do not accept it. Haiku 4.5 has no effort parameter and errors if
   * one is sent, so this cannot simply default.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
};

/**
 * Measured on 32 identical replies (four-way classification of one reply against one
 * question), accuracy / median latency:
 *
 *   opus-5 · medium   100.0%  3308ms
 *   opus-5 · low      100.0%  3120ms   <- chosen
 *   haiku-4-5          93.8%  2936ms
 *
 * Haiku buys 370ms and costs 6 points of accuracy; with one wrong answer in 25 flipping the
 * archetype 15.4% of the time, that trades ~7 points of archetype agreement for ~1% of a
 * turn. `low` matches `medium` exactly here and spends fewer thinking tokens.
 *
 * Do not reach for a more capable model to make this faster. Claude Fable 5 is the most
 * capable model, not the quickest: thinking is always on and cannot be disabled, turns can
 * run minutes, and it is priced above Opus. The task is a four-way classification.
 */
export const DEFAULT_EXTRACTOR_CONFIG: ExtractorConfig = {
  model: "claude-opus-5",
  effort: "low",
  maxTokens: 8000,
};

export type ExtractionWithQuote = Extraction & { certainty: Certainty; quote: string };

const SYSTEM = `You read what someone says about how they lead and work, and match it against a fixed set of multiple-choice questions.

For each question you are shown, decide whether what the person actually said answers it. If it does, choose the option that best matches what they said.

Rules:
- Only answer a question the person genuinely addressed. If they said nothing bearing on it, leave it out entirely. Omitting a question is always better than guessing at one — a question you skip simply gets asked; a question you get wrong is never caught.
- Match what they said, not what you would infer about their personality. A person describing one project is not thereby telling you their approach to risk.
- Report your certainty honestly:
    explicit — they stated it outright
    implied  — it clearly follows from what they said
    inferred — a reasonable reading, but a stretch
- Quote the words that drove your choice, verbatim from what they said. Keep it short and do not paraphrase.
- If two options both fit, prefer the one closest to their own wording and mark it implied or inferred rather than explicit.`;

/** Structured output schema. Object types need `additionalProperties: false` and `required`. */
function schemaFor(openQuestions: number[]) {
  return {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionNumber: { type: "integer", enum: openQuestions.map((q) => q + 1) },
            optionNumber: {
              type: "integer",
              enum: Array.from({ length: OPTIONS_PER_QUESTION }, (_, i) => i + 1),
            },
            certainty: { type: "string", enum: ["explicit", "implied", "inferred"] },
            quote: { type: "string" },
          },
          required: ["questionNumber", "optionNumber", "certainty", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  };
}

function renderQuestions(openQuestions: number[]): string {
  return openQuestions
    .map((q) => {
      const options = questions[q].options.map((o, i) => `    ${i + 1}. ${o.text}`).join("\n");
      return `${q + 1}. ${questions[q].text}\n${options}`;
    })
    .join("\n\n");
}

/**
 * Extract answers from one utterance.
 *
 * @param openQuestions zero-based indexes of questions still unanswered.
 * @param utterance     what the person said, verbatim.
 */
export async function extract(
  openQuestions: number[],
  utterance: string,
  config: ExtractorConfig = DEFAULT_EXTRACTOR_CONFIG,
  client = new Anthropic(),
): Promise<ExtractionWithQuote[]> {
  if (openQuestions.length === 0) return [];

  const response = await client.messages.create({
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM,
    output_config: {
      ...(config.effort ? { effort: config.effort } : {}),
      format: { type: "json_schema", schema: schemaFor(openQuestions) },
    },
    messages: [
      {
        role: "user",
        content: `Questions still open:

${renderQuestions(openQuestions)}

What the person said:
"""
${utterance}
"""

Return only the questions this genuinely answers.`,
      },
    ],
  });

  // A safety refusal returns 200 with an empty or partial body — check before reading.
  if (response.stop_reason === "refusal") {
    throw new Error(`Extraction refused (${response.stop_details?.category ?? "unknown"})`);
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return [];

  const parsed = JSON.parse(text.text) as {
    answers: { questionNumber: number; optionNumber: number; certainty: Certainty; quote: string }[];
  };

  const open = new Set(openQuestions);
  return parsed.answers
    // Structured outputs constrain the shape, not the semantics — drop anything that
    // names a question we did not ask about rather than letting it reach the controller,
    // which would (correctly) throw.
    .filter((a) => open.has(a.questionNumber - 1))
    .map((a) => ({
      questionIndex: a.questionNumber - 1,
      value: a.optionNumber - 1,
      confidence: CONFIDENCE[a.certainty],
      certainty: a.certainty,
      quote: a.quote,
    }));
}
