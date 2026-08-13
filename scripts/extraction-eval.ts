import "./load-env";
import Anthropic from "@anthropic-ai/sdk";
import { PROFILE_COUNT, questions, score } from "@/lib/scoring";
import { buildPersonas } from "@/lib/interview/persona";
import { extract, DEFAULT_EXTRACTOR_CONFIG, type ExtractorConfig } from "@/lib/interview/extractor";

/**
 * Measures the assumption everything else rests on: how accurate is real extraction from
 * real language, and what archetype agreement does that produce?
 *
 * The persona harness (scripts/interview-sim.ts) GUESSED 90% accuracy with independent
 * errors. This replaces the guess with a measurement.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE NUMBER.
 * The narratives here are model-generated from known answer sets, because no corpus of
 * real ones exists yet. That biases the result OPTIMISTICALLY: generated prose is more
 * organised, more on-topic, and more complete than what a person types into a chat box at
 * an event. Treat the output as an upper bound and a way to compare configurations
 * against each other — not as the accuracy you will see in production. The corpus that
 * settles it is Stage 0: one open question after the existing tap quiz, storing what people
 * actually write beside the answers they actually gave.
 *
 * To reduce the most obvious circularity, narratives are generated WITHOUT showing the
 * option text — the writer is told the disposition in its own words and never sees the
 * phrasing the extractor will match against. Otherwise this would measure paraphrase
 * detection rather than extraction.
 *
 * Run: npx tsx scripts/extraction-eval.ts [personaCount]
 */

const COUNT = Number(process.argv[2] ?? 8);
const client = new Anthropic();

/** Ask a model to write how this person would describe themselves — options never shown. */
async function writeNarrative(answers: number[]): Promise<string> {
  // Describe the person by their own chosen statements, stripped of the option framing.
  const traits = answers
    .map((a, q) => questions[q].options[a].text)
    .filter((_, i) => i % 3 === 0) // a subset, so the narrative is natural rather than a list
    .join(" ");

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    output_config: { effort: "low" },
    system:
      "You write short, natural first-person accounts of how someone leads and works. " +
      "Write the way a real person types into a chat box: concrete, a bit rambling, specific about actual situations. " +
      "Do not use bullet points, headings, or the phrasing of a personality questionnaire. Do not name any framework or archetype.",
    messages: [
      {
        role: "user",
        content: `Write 150-250 words in the first person, as someone whose working style genuinely reflects all of this:

${traits}

Talk about specific things you have done and how you handle situations. Do not list traits.`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("Narrative generation refused");
  const text = response.content.find((b) => b.type === "text");
  return text && text.type === "text" ? text.text : "";
}

type Result = {
  answered: number;
  correct: number;
  truthArchetype: number;
  extractedArchetype: number | null;
  agreed: boolean;
  byCertainty: Record<string, { n: number; correct: number }>;
};

async function evaluate(personaIndex: number, config: ExtractorConfig): Promise<Result> {
  const persona = buildPersonas(COUNT, 7)[personaIndex];
  const narrative = await writeNarrative(persona.truth);

  const all = Array.from({ length: questions.length }, (_, i) => i);
  const extracted = await extract(all, narrative, config, client);

  const byCertainty: Record<string, { n: number; correct: number }> = {};
  let correct = 0;
  for (const e of extracted) {
    const right = e.value === persona.truth[e.questionIndex];
    if (right) correct += 1;
    byCertainty[e.certainty] ??= { n: 0, correct: 0 };
    byCertainty[e.certainty].n += 1;
    if (right) byCertainty[e.certainty].correct += 1;
  }

  // Archetype comparison needs a full answer set. Fill the gaps with the person's real
  // answers — i.e. assume the interview loop would have asked and got them right — so this
  // isolates extraction error rather than re-measuring the loop.
  const filled = [...persona.truth];
  for (const e of extracted) filled[e.questionIndex] = e.value;

  return {
    answered: extracted.length,
    correct,
    truthArchetype: persona.archetype,
    extractedArchetype: score(filled).profile,
    agreed: score(filled).profile === persona.archetype,
    byCertainty,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — add it to .env.local and re-run.");
    process.exit(1);
  }

  console.log(`Extraction evaluation — ${COUNT} personas, model ${DEFAULT_EXTRACTOR_CONFIG.model}`);
  console.log("Narratives are model-generated: treat these numbers as an UPPER BOUND.\n");

  const results: Result[] = [];
  for (let i = 0; i < COUNT; i += 1) {
    const r = await evaluate(i, DEFAULT_EXTRACTOR_CONFIG);
    results.push(r);
    console.log(
      `  persona ${String(i + 1).padStart(2)}  answered ${String(r.answered).padStart(2)}/25  ` +
        `correct ${String(r.correct).padStart(2)}  ` +
        `archetype ${r.extractedArchetype} vs ${r.truthArchetype}  ${r.agreed ? "MATCH" : "MISMATCH"}`,
    );
  }

  const answered = results.reduce((a, r) => a + r.answered, 0);
  const correct = results.reduce((a, r) => a + r.correct, 0);
  const agreed = results.filter((r) => r.agreed).length;

  console.log("");
  console.log(`  coverage           ${((answered / (COUNT * 25)) * 100).toFixed(1)}%  (questions one narrative answers)`);
  console.log(`  accuracy           ${((correct / Math.max(answered, 1)) * 100).toFixed(1)}%  (of the answers it did give)`);
  console.log(`  archetype agreement ${((agreed / COUNT) * 100).toFixed(1)}%`);
  console.log("");
  console.log("  Accuracy by certainty — the threshold only works if these separate:");
  const merged: Record<string, { n: number; correct: number }> = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.byCertainty)) {
      merged[k] ??= { n: 0, correct: 0 };
      merged[k].n += v.n;
      merged[k].correct += v.correct;
    }
  }
  for (const k of ["explicit", "implied", "inferred"]) {
    const v = merged[k];
    if (!v) continue;
    console.log(`    ${k.padEnd(9)} ${String(v.n).padStart(3)} answers  ${((v.correct / v.n) * 100).toFixed(1)}% correct`);
  }
  console.log("");
  console.log(`  Compare with the simulated assumption: 90% per-question accuracy.`);
  console.log(`  Profiles reachable in this cohort: ${new Set(results.map((r) => r.truthArchetype)).size} of ${PROFILE_COUNT}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
