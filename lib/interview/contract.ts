/**
 * THE CONTRACT for the conversational intake.
 *
 * Every module in the interview build codes against these types. They are defined in one
 * place, first, because the pieces are being written in parallel and an invented interface
 * is the failure mode that costs more than it saves.
 *
 * Design decisions already settled by measurement — do not relitigate in implementation:
 *
 *   1. DIRECT ANSWERS ONLY. The agent asks question N, the person answers question N.
 *      Measured 97.9% accurate. Mining several answers out of one narrative ("spillover")
 *      measured 60.6% and is not built.
 *   2. THE QUESTION TEXT IS VERBATIM. The model writes the sentence before the question,
 *      never the question. lib/interview/phrasing.ts enforces this mechanically.
 *   3. THE MODEL NEVER SEES SCORING. Phrasing and extraction receive question and option
 *      TEXT only. score() stays server-side, pure, and unchanged.
 *   4. AN UNCERTAIN ANSWER IS NEVER KEPT. Below the confidence threshold the controller
 *      issues a narrowing turn instead. One wrong answer in 25 changes the archetype
 *      15.4% of the time.
 *   5. THE TAP FORM IS THE FLOOR. The interview REPLACES the form as the primary journey,
 *      but the four options remain one tap away on every turn, and the turn budget always
 *      lands on the form for whatever is left. In a room, that floor is the difference
 *      between a slow completion and a lost one — it is not optional polish.
 *
 * Known constraint, recorded rather than hidden: a typed interview measures at 16-20
 * minutes against the form's 3. Voice input and a cheaper extraction model are the two
 * levers on that; neither is assumed by this contract.
 */

import type { Certainty } from "./extractor";

/* ------------------------------------------------------------------ *
 * Persistence
 *
 * A 16-20 minute interview cannot hold state in React the way the 3-minute form does, so
 * the draft is persisted per turn. The canonical write to `responses` still happens ONCE,
 * at the end, in the same transaction as today — drafts are a separate, disposable tier.
 * ------------------------------------------------------------------ */

/** One exchange, stored in order. `agent` turns carry no answer. */
export type TranscriptTurn =
  | { role: "agent"; text: string; questionIndex: number; kind: "ask" | "confirm"; at: string }
  | { role: "person"; text: string; at: string }
  /** The person tapped an option rather than typing. */
  | { role: "person"; text: string; tapped: number; at: string };

/** The audit trail: why each answer is what it is. Powers "why did I get this?". */
export type AnswerProvenance = {
  questionIndex: number;
  value: number;
  certainty: Certainty | "tapped" | "confirmed";
  /** Verbatim span of the person's words that drove it. Empty when tapped. */
  quote: string;
  turn: number;
};

export type InterviewDraft = {
  /** nanoid(14). The client holds this; it is not a scorecard id. */
  id: string;
  eventSlug: string | null;
  teamSlug: string | null;
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    mobile: string;
    company: string | null;
  };
  /** length 25; null where unsettled. */
  answers: (number | null)[];
  transcript: TranscriptTurn[];
  provenance: AnswerProvenance[];
  turn: number;
  createdAt: Date;
  updatedAt: Date;
};

/* ------------------------------------------------------------------ *
 * API
 *
 * Two endpoints. Both are POST, both are rate-limited, neither streams in v1 — the
 * acknowledgement is short enough that streaming is a polish item, not a requirement.
 * ------------------------------------------------------------------ */

/** POST /api/interview/start */
export type StartRequest = {
  contact: InterviewDraft["contact"];
  event?: string | null;
  teamSlug?: string | null;
};

export type StartResponse = {
  draftId: string;
  /** The opening agent turn, already phrased. */
  ask: AgentTurn;
};

/** POST /api/interview/turn */
export type TurnRequest = {
  draftId: string;
  /** What the person typed. Mutually exclusive with `tapped`. */
  reply?: string;
  /** The option index they tapped instead of typing. */
  tapped?: number;
};

export type AgentTurn = {
  /** The full text to show, acknowledgement plus verbatim question. */
  text: string;
  questionIndex: number;
  kind: "ask" | "confirm";
  /** Always sent, so the tap-out escape hatch can render without another round trip. */
  options: string[];
  /** 0-1, for an unlabelled progress bar. Never render this as "N of 25". */
  progress: number;
  /**
   * True when this turn re-asks a question because the last answer could not be read.
   * The UI reveals the options automatically: someone whose answer just missed is exactly
   * who needs the floor put in front of them rather than hidden behind a disclosure.
   */
  retry?: boolean;
};

export type TurnResponse =
  | { status: "continue"; ask: AgentTurn }
  /** All 25 settled; the response row is written and the scorecard exists. */
  | { status: "complete"; resultId: string }
  /** Nothing usable was heard and the turn budget is spent — finish on the tap form. */
  | { status: "fallback"; remaining: number[]; questions: { index: number; text: string; options: string[] }[] };

export type ApiError = { error: string; retryable: boolean };

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

export const INTERVIEW_LIMITS = {
  /** Hard ceiling on agent turns before the rest falls back to tapping. */
  maxTurns: 40,
  /** Longest reply accepted, in characters. Long enough for a rambling answer. */
  maxReplyChars: 2000,
  /** Per-draft turns per minute. Abuse protection, not a gate. */
  turnsPerMinute: 30,
  /** A draft older than this is abandoned and may be swept. */
  draftTtlHours: 48,
} as const;

/**
 * Written on every response. The interview is now the primary journey and the form is the
 * fallback, but both still record their mode: without it there is no way to tell whether a
 * shifted archetype distribution came from the new instrument or from the cohort, and the
 * 499-response baseline was gathered on the form.
 */
export type IntakeMode = "tap" | "interview" | "interview_fallback";
