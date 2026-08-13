import "./load-env";
import Anthropic from "@anthropic-ai/sdk";
import { OPTIONS_PER_QUESTION, QUESTION_COUNT, questions } from "@/lib/scoring";
import { extract, DEFAULT_EXTRACTOR_CONFIG } from "@/lib/interview/extractor";
import { makeRng } from "@/lib/interview/leverage";

/**
 * The measurement the narrative eval does NOT make.
 *
 * scripts/extraction-eval.ts measures SPILLOVER: mining answers to questions the person
 * was never asked, out of a general narrative. That is the hard case, and it scores badly.
 *
 * This measures the DIRECT case — the agent asks question N, the person answers question N,
 * and the extractor maps that reply to one of the four options. It is the primary path
 * through the interview loop and the one that determines whether the design is viable at
 * all, so it needs its own number rather than inheriting the spillover one.
 *
 * Run: npx tsx scripts/direct-extraction-eval.ts [sampleCount]
 */

const COUNT = Number(process.argv[2] ?? 40);
const client = new Anthropic();
const rng = makeRng(20260813);

/**
 * Write what a person would actually say when asked this question, holding this position.
 * The writer is shown the chosen option only — never the other three — so it cannot write
 * "not option 2"-shaped contrastive prose that would make the extractor's job artificial.
 */
async function writeReply(questionText: string, chosenOption: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 1000,
    output_config: { effort: "low" },
    system:
      "You role-play a person being interviewed about how they lead. You reply the way people actually talk: " +
      "one or two sentences, concrete, sometimes hedged or rambling, often with a specific example. " +
      "Never quote or echo the wording you are given — say it in your own words, as your own experience.",
    messages: [
      {
        role: "user",
        content: `You are asked: "${questionText}"

Your genuine position is: ${chosenOption}

Answer in your own words.`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Reply generation refused");
  const text = response.content.find((b) => b.type === "text");
  return text && text.type === "text" ? text.text : "";
}

type Sample = { questionIndex: number; truth: number; got: number | null; certainty: string | null };

async function sample(): Promise<Sample> {
  const questionIndex = Math.floor(rng() * QUESTION_COUNT);
  const truth = Math.floor(rng() * OPTIONS_PER_QUESTION);
  const reply = await writeReply(questions[questionIndex].text, questions[questionIndex].options[truth].text);

  // The extractor sees only this one question — exactly what the controller hands it after
  // an `ask` move — plus all four of its options.
  const extracted = await extract([questionIndex], reply, DEFAULT_EXTRACTOR_CONFIG, client);
  const hit = extracted.find((e) => e.questionIndex === questionIndex);

  return { questionIndex, truth, got: hit ? hit.value : null, certainty: hit ? hit.certainty : null };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Direct extraction — ${COUNT} samples, model ${DEFAULT_EXTRACTOR_CONFIG.model}`);
  console.log("The agent asks question N; the person answers question N. This is the primary path.\n");

  const results: Sample[] = [];
  const BATCH = 8;
  for (let start = 0; start < COUNT; start += BATCH) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(BATCH, COUNT - start) }, () => sample()),
    );
    results.push(...batch);
    process.stdout.write(`  ${results.length}/${COUNT}\r`);
  }

  const answered = results.filter((r) => r.got !== null);
  const correct = answered.filter((r) => r.got === r.truth);
  const abstained = results.length - answered.length;

  console.log(`\n  answered   ${answered.length}/${results.length}  (abstained on ${abstained})`);
  console.log(`  ACCURACY   ${((correct.length / Math.max(answered.length, 1)) * 100).toFixed(1)}%  of the answers it gave`);
  console.log(`  end-to-end ${((correct.length / results.length) * 100).toFixed(1)}%  counting abstentions as not-yet-answered`);
  console.log("");
  for (const level of ["explicit", "implied", "inferred"]) {
    const at = answered.filter((r) => r.certainty === level);
    if (at.length === 0) continue;
    const right = at.filter((r) => r.got === r.truth).length;
    console.log(`    ${level.padEnd(9)} ${String(at.length).padStart(3)} answers  ${((right / at.length) * 100).toFixed(1)}% correct`);
  }
  console.log("");
  console.log("  Compare: spillover extraction (scripts/extraction-eval.ts) scored 60.6%.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
