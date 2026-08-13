import Anthropic from "@anthropic-ai/sdk";

/**
 * THE PHRASING LAYER — the model's entire job on the asking side.
 *
 * It writes the connective tissue between questions: a brief acknowledgement of what the
 * person just said, then the question. What it must NOT do is reword the question.
 *
 * Why that line is drawn there. The 97.9% direct-extraction accuracy was measured with
 * people answering the schema's exact wording. Rephrasing is unmeasured — and worse, it
 * would hand every person a slightly different instrument, which is what makes an
 * archetype distribution impossible to defend against the 499-response baseline. Fixed
 * stimulus, adaptive sequencing, conversational surface.
 *
 * The guarantee is mechanical, not hopeful: `askFor` checks the verbatim question survived
 * and falls back to asking it plainly if it did not.
 */

export type PhrasedAsk = { text: string; verbatimPreserved: boolean };

const SYSTEM = `You are interviewing someone about how they lead. You are given the exact next question to ask, and what the person just said.

Write the interviewer's next turn. It has two parts:
1. One short sentence responding to what they just said — show you heard the specific thing they told you. Not praise, not a summary, not "great answer". If they said nothing yet, skip this part.
2. The question, reproduced EXACTLY as given, word for word, punctuation included.

Rules:
- Never reword, shorten, expand, or re-punctuate the question. Copy it exactly.
- Do not add your own follow-up questions.
- Do not number the questions or mention how many are left.
- Keep the whole turn under 40 words.
- Write like a person, not a form. No bullet points, no headings.`;

export type PhrasingConfig = { model: string; effort: "low" | "medium" | "high" };
/** Already at low effort: this is two sentences, and the person is waiting on it. */
export const DEFAULT_PHRASING: PhrasingConfig = { model: "claude-opus-5", effort: "low" };

/**
 * @param questionText the schema's wording — must appear verbatim in the result.
 * @param lastReply    what the person said last, or null on the opening turn.
 */
export async function askFor(
  questionText: string,
  lastReply: string | null,
  config: PhrasingConfig = DEFAULT_PHRASING,
  client = new Anthropic(),
): Promise<PhrasedAsk> {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 500,
    system: SYSTEM,
    output_config: { effort: config.effort },
    messages: [
      {
        role: "user",
        content: lastReply
          ? `They just said:\n"""\n${lastReply}\n"""\n\nThe exact next question to ask:\n"""\n${questionText}\n"""`
          : `This is the first question. Nothing has been said yet.\n\nThe exact question to ask:\n"""\n${questionText}\n"""`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { text: questionText, verbatimPreserved: true };
  }
  const block = response.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text.trim() : "";

  // The instrument guarantee, enforced rather than trusted. If the model paraphrased,
  // discard its turn and ask the question plainly — a slightly flatter conversation beats
  // an unmeasured stimulus.
  if (!text.includes(questionText)) {
    return { text: questionText, verbatimPreserved: false };
  }
  return { text, verbatimPreserved: true };
}

/** A narrowing turn, used when the extractor was not confident enough to keep an answer. */
export function narrowingAsk(questionText: string, options: string[], heard: number): string {
  const a = options[heard];
  const others = options.filter((_, i) => i !== heard);
  return (
    `I want to make sure I've got you right on this one — "${questionText}" ` +
    `I heard it as "${a}". Is that closest, or is it more one of these: ` +
    others.map((o) => `"${o}"`).join(", ") +
    `?`
  );
}
