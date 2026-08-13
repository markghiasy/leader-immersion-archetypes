import { buildPersonas, DEFAULT_EXTRACTOR, type ExtractorProfile } from "@/lib/interview/persona";
import { runInterview, summarise, type Summary } from "@/lib/interview/simulate";
import { score } from "@/lib/scoring";

/**
 * Convergence harness for the interview controller.
 *
 * No model, no network, no database — simulated interviewees with known ground truth, so
 * the question "does the loop converge, and what extraction quality does it need?" can be
 * answered before any conversational surface exists.
 *
 * Run: npx tsx scripts/interview-sim.ts
 */

const PERSONAS = Number(process.env.SIM_PERSONAS ?? 300);
const personas = buildPersonas(PERSONAS, 7);

function run(config: { maxTurns?: number; ordering?: "leverage" | "sequential"; confidenceThreshold?: number },
             extractor: ExtractorProfile): Summary {
  return summarise(personas.map((p, i) => runInterview(p, config, extractor, i + 1)));
}

function row(label: string, s: Summary) {
  console.log(
    `  ${label.padEnd(26)} ${s.agreement.toFixed(1).padStart(6)}%  ` +
      `${s.meanTurns.toFixed(1).padStart(6)}  ${String(s.medianTurns).padStart(6)}  ${String(s.p90Turns).padStart(5)}  ` +
      `${s.meanConfirms.toFixed(1).padStart(8)}  ${s.fallbackRate.toFixed(1).padStart(9)}%  ${s.meanWrongAnswers.toFixed(2).padStart(7)}`,
  );
}

function header(title: string) {
  console.log(`\n${title}`);
  console.log("  " + "-".repeat(100));
  console.log(
    `  ${"".padEnd(26)} ${"agree".padStart(7)}  ${"mean".padStart(6)}  ${"median".padStart(6)}  ${"p90".padStart(5)}  ` +
      `${"confirms".padStart(8)}  ${"fallback".padStart(10)}  ${"wrong".padStart(7)}`,
  );
  console.log("  " + "-".repeat(100));
}

console.log(`Interview controller — convergence harness`);
console.log(`${personas.length} simulated interviewees, ground truth from perturbed replay vectors.`);

const dist = new Map<number, number>();
for (const p of personas) dist.set(p.archetype, (dist.get(p.archetype) ?? 0) + 1);
console.log(
  `Archetype spread in the cohort: ` +
    [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}:${n}`).join("  "),
);

/* 1 — does the ordering strategy earn its keep? ------------------------------ */
header("1. Slot-selection strategy (extractor accuracy 90%, spillover 50%)");
row("leverage-ordered", run({ ordering: "leverage" }, DEFAULT_EXTRACTOR));
row("sequential (control)", run({ ordering: "sequential" }, DEFAULT_EXTRACTOR));

/* 2 — how good does extraction have to be? ----------------------------------- */
header("2. Extraction accuracy (leverage-ordered, confirm below 0.75)");
for (const accuracy of [0.75, 0.8, 0.85, 0.9, 0.95, 1.0]) {
  row(`accuracy ${(accuracy * 100).toFixed(0)}%`, run({ ordering: "leverage" }, { ...DEFAULT_EXTRACTOR, accuracy }));
}

/* 3 — what does the confirmation step buy? ----------------------------------- */
header("3. Confirmation threshold (accuracy 90%) — 0 means never confirm");
for (const confidenceThreshold of [0, 0.5, 0.65, 0.75, 0.85, 0.95]) {
  row(`threshold ${confidenceThreshold.toFixed(2)}`, run({ ordering: "leverage", confidenceThreshold }, DEFAULT_EXTRACTOR));
}

/* 4 — how much does conversational spillover help? --------------------------- */
header("4. Spillover — how often one answer settles several questions (accuracy 90%)");
for (const spilloverRate of [0, 0.25, 0.5, 0.75, 1.0]) {
  row(`spillover ${(spilloverRate * 100).toFixed(0)}%`, run({ ordering: "leverage" }, { ...DEFAULT_EXTRACTOR, spilloverRate }));
}

/* 5 — the turn budget, which is really the dropout budget -------------------- */
header("5. Turn budget (accuracy 90%, spillover 50%)");
for (const maxTurns of [12, 16, 20, 25, 30, 40]) {
  row(`budget ${maxTurns} turns`, run({ ordering: "leverage", maxTurns }, DEFAULT_EXTRACTOR));
}

console.log("");
console.log("  agree    = same archetype the tap form would have produced");
console.log("  turns    = questions the person actually answers (asks + confirmations)");
console.log("  fallback = share of interviews that ran out of budget and finished as taps");
console.log("  wrong    = mean number of the 25 answers that ended up different from the truth");
console.log("");

// Sanity: the harness must reproduce the form exactly when nothing is lost in translation.
const perfect = summarise(
  personas.map((p, i) => runInterview(p, { ordering: "leverage" }, { accuracy: 1, spilloverRate: 0.5, spilloverMax: 3, confirmAccuracy: 1 }, i + 1)),
);
console.log(`  Control: with a perfect extractor, agreement is ${perfect.agreement.toFixed(1)}% and mean wrong answers ${perfect.meanWrongAnswers.toFixed(2)}.`);
console.log(`  (Anything other than 100% / 0.00 would mean the harness itself is broken.)`);

const truthCheck = personas.every((p) => score(p.truth).profile === p.archetype);
console.log(`  Ground truth self-consistent: ${truthCheck}`);
