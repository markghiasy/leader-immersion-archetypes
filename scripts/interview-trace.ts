import { archetypeTitle } from "@/lib/content";
import { score } from "@/lib/scoring";
import {
  applyConfirmation,
  applyExtractions,
  applyFallback,
  commitMove,
  createInterview,
  nextMove,
  remaining,
} from "@/lib/interview/controller";
import { makeRng } from "@/lib/interview/leverage";
import { buildPersonas, confirmAnswer, DEFAULT_EXTRACTOR, respond, tapRemaining } from "@/lib/interview/persona";

/**
 * Print one interview, move by move, so the mechanics are visible without a model, a
 * server, or a deployment.
 *
 * Everything here is really produced by the controller. What a language model would say
 * is NOT shown — only the question text it would be handed, which is the schema's own
 * fixed wording.
 *
 * Run: npx tsx scripts/interview-trace.ts [personaIndex]
 */

const index = Number(process.argv[2] ?? 0);
const persona = buildPersonas(20, 7)[index];
const rng = makeRng(index * 7919 + 13);

let state = createInterview({ ordering: "sequential", maxTurns: 25, confidenceThreshold: 0.75, seed: index + 1 });

const settled = () => state.slots.filter((s) => s.status === "confirmed").length;
const label = (n: number) => `q${String(n + 1).padStart(2, "0")}`;

console.log(`Interview trace — persona ${persona.id}`);
console.log(`Their true archetype (what the tap form would give): ${archetypeTitle(persona.archetype)}`);
console.log("");

for (let guard = 0; guard < 60; guard += 1) {
  const move = nextMove(state);

  if (move.kind === "complete") {
    const result = score(move.answers).profile;
    const wrong = move.answers.filter((a, i) => a !== persona.truth[i]).length;
    console.log("");
    console.log(`  DONE after ${state.turn} turns.`);
    console.log(`  Result: ${archetypeTitle(result)}`);
    console.log(`  Truth:  ${archetypeTitle(persona.archetype)}   ${result === persona.archetype ? "MATCH" : "MISMATCH"}`);
    console.log(`  Answers different from the truth: ${wrong} of 25`);
    break;
  }

  if (move.kind === "fallback") {
    console.log(`\n  [budget spent] ${move.remaining.length} questions handed to the tap form rather than guessed.`);
    state = applyFallback(state, tapRemaining(persona, move.remaining));
    state = commitMove(state, move);
    continue;
  }

  if (move.kind === "confirm") {
    console.log(
      `  turn ${String(state.turn + 1).padStart(2)}  CONFIRM ${label(move.questionIndex)}  ` +
        `(heard option ${move.value + 1} at ${move.confidence.toFixed(2)} — below threshold)`,
    );
    console.log(`            asks again: "${move.text}"`);
    console.log(`            narrowing between: ${move.options.map((o, i) => `[${i + 1}] ${o}`).join("  ")}`);
    state = commitMove(state, move);
    const answer = confirmAnswer(persona, move.questionIndex, DEFAULT_EXTRACTOR, rng);
    state = applyConfirmation(state, move.questionIndex, answer);
    console.log(`            person settles on option ${answer + 1}  ->  confirmed   [${settled()}/25 settled]`);
    console.log("");
    continue;
  }

  console.log(`  turn ${String(state.turn + 1).padStart(2)}  ASK     ${label(move.questionIndex)}  "${move.text}"`);
  state = commitMove(state, move);
  const open = remaining(state).filter((q) => state.slots[q].status === "unfilled");
  const heard = respond(persona, move.questionIndex, open, DEFAULT_EXTRACTOR, rng);

  for (const e of heard) {
    const isPrimary = e.questionIndex === move.questionIndex;
    const status = e.confidence >= 0.75 ? "confirmed" : "needs confirming";
    const correct = e.value === persona.truth[e.questionIndex] ? "" : "   <- WRONG";
    console.log(
      `            ${isPrimary ? "answers  " : "also settles"} ${label(e.questionIndex)} ` +
        `= option ${e.value + 1} at ${e.confidence.toFixed(2)}  ->  ${status}${correct}`,
    );
  }
  state = applyExtractions(state, heard);
  console.log(`            [${settled()}/25 settled]`);
  console.log("");
}
