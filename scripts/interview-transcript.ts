import "./load-env";
import Anthropic from "@anthropic-ai/sdk";
import { archetypeTitle } from "@/lib/content";
import { score } from "@/lib/scoring";
import {
  applyConfirmation,
  applyExtractions,
  commitMove,
  createInterview,
  nextMove,
  remaining,
} from "@/lib/interview/controller";
import { buildPersonas } from "@/lib/interview/persona";
import { extract, DEFAULT_EXTRACTOR_CONFIG } from "@/lib/interview/extractor";
import { askFor, narrowingAsk } from "@/lib/interview/phrasing";

/**
 * Runs a REAL interview end to end and prints the thread, turn by turn.
 *
 * Everything is live: the controller chooses what to ask, a model phrases the turn, a
 * model plays the interviewee, and the real extractor maps each reply to an option. The
 * only fiction is the interviewee.
 *
 * Direct answers only — no spillover mining. That decision comes from the measurement:
 * direct extraction is 97.9% accurate, spillover 60.6%.
 *
 * Run: npx tsx scripts/interview-transcript.ts [personaIndex] [maxTurns]
 */

const PERSONA_INDEX = Number(process.argv[2] ?? 0);
const MAX_TURNS = Number(process.argv[3] ?? 10);
const client = new Anthropic();

const persona = buildPersonas(20, 7)[PERSONA_INDEX];

/** The interviewee. Answers the question actually asked, holding a fixed real position. */
async function reply(questionText: string, chosenOption: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 800,
    output_config: { effort: "low" },
    system:
      "You are being interviewed about how you lead. Reply the way people actually talk — one or two sentences, " +
      "concrete, sometimes with a specific example, occasionally hedged. Never quote the wording you are given.",
    messages: [
      { role: "user", content: `You are asked: "${questionText}"\n\nYour genuine position is: ${chosenOption}\n\nAnswer in your own words.` },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

function wrap(label: string, text: string): string {
  const width = 76;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l, i) => `  ${i === 0 ? label : " ".repeat(label.length)} ${l}`).join("\n");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Live interview — persona ${persona.id}`);
  console.log(`Their true archetype (what the tap form would give): ${archetypeTitle(persona.archetype)}`);
  console.log(`Showing the first ${MAX_TURNS} turns.\n`);
  console.log("─".repeat(80));

  let state = createInterview({ ordering: "sequential", maxTurns: 40, confidenceThreshold: 0.75 });
  let lastReply: string | null = null;
  let paraphraseCaught = 0;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const move = nextMove(state);
    if (move.kind === "complete" || move.kind === "fallback") break;

    if (move.kind === "confirm") {
      const ask = narrowingAsk(move.text, move.options, move.value);
      console.log(`\n  [turn ${state.turn + 1} · checking back — heard at ${move.confidence.toFixed(2)} confidence]`);
      console.log(wrap("AGENT  ", ask));
      state = commitMove(state, move);
      const settled = persona.truth[move.questionIndex];
      console.log(wrap("PERSON ", `Yeah — it's more "${move.options[settled]}".`));
      state = applyConfirmation(state, move.questionIndex, settled);
      console.log(`         → settled  [${state.slots.filter((s) => s.status === "confirmed").length}/25]`);
      lastReply = null;
      continue;
    }

    const ask = await askFor(move.text, lastReply, undefined, client);
    if (!ask.verbatimPreserved) paraphraseCaught += 1;
    console.log("");
    console.log(wrap("AGENT  ", ask.text));

    const answer = await reply(move.text, persona.truth[move.questionIndex] !== undefined
      ? questionOption(move.options, persona.truth[move.questionIndex])
      : move.options[0]);
    console.log(wrap("PERSON ", answer));

    state = commitMove(state, move);
    const heard = await extract([move.questionIndex], answer, DEFAULT_EXTRACTOR_CONFIG, client);
    state = applyExtractions(state, heard);
    lastReply = answer;

    const h = heard[0];
    const settled = state.slots.filter((s) => s.status === "confirmed").length;
    if (!h) {
      console.log(`         → nothing usable heard; will re-ask  [${settled}/25]`);
    } else {
      const right = h.value === persona.truth[move.questionIndex] ? "" : "  ← WRONG";
      console.log(
        `         → option ${h.value + 1}, ${h.certainty}` +
          `${h.certainty === "inferred" ? " (below threshold — will check back)" : ""}${right}  [${settled}/25]`,
      );
      console.log(`           quote: "${h.quote}"`);
    }
  }

  console.log("\n" + "─".repeat(80));
  const settled = state.slots.filter((s) => s.status === "confirmed").length;
  console.log(`  ${settled} of 25 settled in ${state.turn} turns · ${remaining(state).length} to go`);
  const wrong = state.slots.filter((s, i) => s.status === "confirmed" && s.value !== persona.truth[i]).length;
  console.log(`  wrong so far: ${wrong}`);
  if (paraphraseCaught > 0) {
    console.log(`  ⚠ ${paraphraseCaught} turn(s) paraphrased the question and were replaced with the verbatim text`);
  } else {
    console.log(`  verbatim question text preserved on every turn`);
  }
  const provisional = state.slots.map((s, i) => (s.value === null ? persona.truth[i] : s.value));
  console.log(`  archetype on current answers: ${archetypeTitle(score(provisional).profile)}`);
}

/** The interviewee's real position, expressed as the option text they'd endorse. */
function questionOption(options: string[], index: number): string {
  return options[index];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
