import "./load-env";
import Anthropic from "@anthropic-ai/sdk";
import { OPTIONS_PER_QUESTION, QUESTION_COUNT, questions, score } from "@/lib/scoring";
import { archetypeTitle } from "@/lib/content";
import { makeRng } from "@/lib/interview/leverage";

/**
 * Fifteen simulated people take the REAL interview, end to end, against the LIVE API.
 *
 * The question this answers is the one nobody has: does a realistic person finish? Every
 * previous measurement tested a component. This tests the product.
 *
 * The cohort varies by ANSWER STYLE, not by device — the API is identical from any client,
 * and the variable that has actually killed interviews is how much a person types. Two live
 * attempts died on "with enthusiasm".
 *
 * Run: npx tsx scripts/synthetic-cohort.ts [baseUrl]
 */

const BASE = process.argv[2] ?? "https://leader-archetype-quiz.vercel.app";
const PER_STYLE = 5;
const client = new Anthropic();

type Style = { key: string; label: string; brief: string };

const STYLES: Style[] = [
  {
    key: "terse",
    label: "Terse",
    brief:
      "You answer in three to eight words. Blunt, no examples, no elaboration — the way someone replies " +
      "while half-distracted at an event. Never a full sentence if a fragment will do.",
  },
  {
    key: "conversational",
    label: "Conversational",
    brief:
      "You answer in one or two sentences, usually with a concrete detail or a quick example from work. " +
      "This is someone who read the instructions and is engaging properly.",
  },
  {
    key: "rambling",
    label: "Rambling",
    brief:
      "You answer in three to five sentences that wander — you start on the question, digress into an " +
      "anecdote, hedge, contradict yourself slightly, and only half return to the point.",
  },
];

type Result = {
  style: string;
  person: string;
  completed: boolean;
  turns: number;
  reAsks: number;
  narrowings: number;
  fellBack: boolean;
  resultId: string | null;
  archetype: number | null;
  truthArchetype: number;
  agreed: boolean | null;
  failedAt: string | null;
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

/** The person answers the question they were asked, in their assigned style. */
async function answer(style: Style, agentTurn: string, position: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 600,
    output_config: { effort: "low" },
    system:
      `You are being interviewed about how you lead. ${style.brief} ` +
      "Never quote or echo the wording you are given — say it your own way. Never mention options or lists.",
    messages: [
      {
        role: "user",
        content: `The interviewer just said:\n"""\n${agentTurn}\n"""\n\nYour genuine position on this: ${position}\n\nReply.`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

type Ask = { text: string; questionIndex: number; kind: string; options: string[]; progress: number; retry?: boolean };

async function runOne(style: Style, index: number): Promise<Result> {
  const rng = makeRng(index * 7919 + style.key.length);
  const truth = Array.from({ length: QUESTION_COUNT }, () => Math.floor(rng() * OPTIONS_PER_QUESTION));
  const person = `${style.label}${index}`;
  const base: Result = {
    style: style.key,
    person,
    completed: false,
    turns: 0,
    reAsks: 0,
    narrowings: 0,
    fellBack: false,
    resultId: null,
    archetype: null,
    truthArchetype: score(truth).profile,
    agreed: null,
    failedAt: null,
  };

  try {
    const start = await post<{ draftId: string; ask: Ask }>("/api/interview/start", {
      contact: {
        firstName: style.label,
        lastName: `Cohort${index}`,
        email: `cohort.${style.key}.${index}@example.com`,
        mobile: `0400 100 ${String(index).padStart(3, "0")}`,
        company: null,
      },
      event: "melbourne-aug",
    });

    let draftId = start.draftId;
    let ask: Ask = start.ask;

    // Bounded well above the 40-turn budget: the server stops us, this only stops a bug.
    for (let guard = 0; guard < 70; guard += 1) {
      base.turns += 1;
      if (ask.retry) base.reAsks += 1;
      if (ask.kind === "confirm") base.narrowings += 1;

      const reply = await answer(style, ask.text, questions[ask.questionIndex].options[truth[ask.questionIndex]].text);
      const turn = await post<
        | { status: "continue"; ask: Ask }
        | { status: "complete"; resultId: string }
        | { status: "fallback"; remaining: number[]; questions: { index: number; options: string[] }[] }
      >("/api/interview/turn", { draftId, reply });

      if (turn.status === "complete") {
        base.completed = true;
        base.resultId = turn.resultId;
        break;
      }
      // (archetype is resolved after the loop — see below)
      if (turn.status === "fallback") {
        // The budget ran out. Drain it the way the UI does: one tap per question, in order.
        base.fellBack = true;
        let last: { status: string; resultId?: string } | null = null;
        for (const q of turn.questions) {
          last = await post("/api/interview/turn", { draftId, tapped: truth[q.index] });
        }
        if (last?.status === "complete" && last.resultId) {
          base.completed = true;
          base.resultId = last.resultId;
        }
        break;
      }
      ask = turn.ask;
    }
    // Read back what the system ACTUALLY produced. Reporting the persona's own truth here
    // would have silently turned an accuracy measurement into a tautology.
    if (base.resultId) {
      const page = await fetch(`${BASE}/r/${base.resultId}`).then((r) => r.text());
      const match = /([1-8])\.\s*The\s+[A-Za-z ]+/.exec(page.replace(/<!-- -->/g, ""));
      base.archetype = match ? Number(match[1]) : null;
      base.agreed = base.archetype === base.truthArchetype;
    }
  } catch (error) {
    base.failedAt = error instanceof Error ? error.message.slice(0, 140) : String(error);
  }

  return base;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  console.log(`Synthetic cohort — ${STYLES.length} styles × ${PER_STYLE} people against ${BASE}`);
  console.log("Every interview is real: live API, real extraction, real scoring.\n");

  const jobs = STYLES.flatMap((style) =>
    Array.from({ length: PER_STYLE }, (_, i) => () => runOne(style, i + 1)),
  );

  // All fifteen concurrently: each interview is sequential in itself, so wall clock is one
  // interview, not fifteen.
  const results = await Promise.all(jobs.map((job) => job()));

  for (const style of STYLES) {
    const rows = results.filter((r) => r.style === style.key);
    const done = rows.filter((r) => r.completed);
    const conversational = done.filter((r) => !r.fellBack);
    console.log(`\n  ${style.label.toUpperCase()}  (${style.brief.split(".")[0].toLowerCase()})`);
    console.log("  " + "-".repeat(74));
    for (const r of rows) {
      const outcome = r.failedAt
        ? `ERROR ${r.failedAt}`
        : r.completed
          ? `${r.fellBack ? "via fallback" : "conversational"} → ${r.archetype ? archetypeTitle(r.archetype) : "?"}` +
            `${r.agreed === false ? `  MISMATCH (truth ${archetypeTitle(r.truthArchetype)})` : ""}`
          : "did not finish";
      console.log(
        `    ${r.person.padEnd(16)} turns ${String(r.turns).padStart(2)}  re-asks ${String(r.reAsks).padStart(2)}  ` +
          `checks ${String(r.narrowings).padStart(2)}  ${outcome}`,
      );
    }
    const meanReAsk = rows.reduce((a, r) => a + r.reAsks, 0) / rows.length;
    console.log(
      `    → completed ${done.length}/${rows.length}, of which ${conversational.length} without falling back · ` +
        `mean re-asks ${meanReAsk.toFixed(1)} · mean turns ${(rows.reduce((a, r) => a + r.turns, 0) / rows.length).toFixed(1)}`,
    );
  }

  const all = results.filter((r) => !r.failedAt);
  const finished = all.filter((r) => r.completed);
  console.log("\n  " + "=".repeat(74));
  console.log(`  COMPLETED            ${finished.length}/${results.length}`);
  console.log(`  fully conversational ${finished.filter((r) => !r.fellBack).length}/${results.length}`);
  console.log(`  errored              ${results.filter((r) => r.failedAt).length}`);
  console.log(`  mean re-asks/person  ${(all.reduce((a, r) => a + r.reAsks, 0) / Math.max(all.length, 1)).toFixed(1)}`);
  console.log("");
  console.log("  Re-asks are the signal: they are how often someone was told their answer was too thin.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
