"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { INTERVIEW_LIMITS } from "@/lib/interview/contract";
import type { AgentTurn, ApiError, StartResponse, TurnResponse } from "@/lib/interview/contract";
import type { ClientQuestion } from "@/lib/scoring";
import { contactSchema, fieldErrors } from "@/lib/validation";
import quiz from "./quiz.module.css";
import styles from "./interview.module.css";

/**
 * The conversational intake, client side.
 *
 * The interview is now the primary journey, so this component carries the whole risk the
 * contract describes: a 16-20 minute typed conversation where every turn is a 3-5 second
 * round trip. Three consequences run through everything below.
 *
 *   1. THE TAP FORM IS THE FLOOR. The four options are never more than one tap away —
 *      "Or choose an answer" is rendered on every single turn, not behind a menu, not
 *      after a stall timer. In a room, that control is the difference between a slow
 *      completion and a lost one.
 *   2. NOTHING THEY TYPED IS EVER LOST. A failed turn rolls the optimistic bubble back and
 *      hands their words back to the textarea, editable, with a retry that re-sends the
 *      exact same payload. Twenty minutes of answers make a dropped reply unforgivable.
 *   3. NO COUNT IS EVER SHOWN. `ask.progress` drives an unlabelled bar. The controller
 *      picks questions by leverage and may confirm as well as ask, so "N of 25" would be
 *      both wrong and discouraging.
 *
 * Server state lives on the server: the draft is persisted per turn, and this component
 * holds only the draft id, the visible transcript and what is in the input box.
 */

type ContactState = {
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
  company: string;
};

const EMPTY_CONTACT: ContactState = { firstName: "", lastName: "", email: "", mobile: "", company: "" };
const OPTION_KEYS = ["A", "B", "C", "D"];
/** Same beat the tap form holds, so the reveal never flashes past. */
const CALCULATING_MS = 1400;

/** What the person sees, which is not the same thing as the stored transcript. */
type ThreadTurn = { role: "agent"; text: string } | { role: "person"; text: string };

/** What we sent, kept so a failed turn can be retried byte-for-byte. */
type Attempt = { payload: { reply?: string; tapped?: number }; personText: string };

/** A remaining question, rendered as the plain tap form after a `fallback` response. */
type FallbackQuestion = { index: number; text: string; options: string[] };

type Phase = "intro" | "contact" | "thread" | "calculating";

export type InterviewChatProps = {
  /**
   * Accepted for parity with the tap form's entry points and deliberately unused: the
   * agent turn, its options and its progress all arrive from the API, and the question
   * order is chosen server-side by leverage, so a client-side list could only disagree.
   */
  questions?: ClientQuestion[];
  /** Entry context, carried to the server at start time for attribution. */
  event?: string | null;
  teamSlug?: string | null;
  /** Hero copy, rendered by the server so the entry page is static and instant. */
  intro: React.ReactNode;
  startLabel?: string;
};

/** Anything the interview endpoints can go wrong with, carrying the contract's retry flag. */
class InterviewError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "InterviewError";
    this.retryable = retryable;
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // A dropped connection is the most likely failure on a conference wifi, and it is
    // always worth another go.
    throw new InterviewError("We could not reach the server just then.", true);
  }

  const data = (await response.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!response.ok || !data || typeof data.error === "string") {
    const message = data?.error || "Something went wrong on our end.";
    // Absent an explicit flag, treat 5xx as worth retrying and 4xx as not.
    const retryable = typeof data?.retryable === "boolean" ? data.retryable : response.status >= 500;
    throw new InterviewError(message, retryable);
  }
  return data;
}

const DRAFT_KEY = "leader-archetype:draft";

export default function InterviewChat({
  event,
  teamSlug,
  intro,
  startLabel = "Start the conversation",
}: InterviewChatProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intro");
  const [contact, setContact] = useState<ContactState>(EMPTY_CONTACT);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Persisted, not just held in state: a 16-20 minute interview outlives a backgrounded
  // tab on iOS, an accidental refresh, or a dropped connection. Losing the handle loses
  // everything the person has typed.
  const [draftId, setDraftIdState] = useState<string | null>(null);
  const setDraftId = useCallback((id: string | null) => {
    setDraftIdState(id);
    try {
      if (id) window.sessionStorage.setItem(DRAFT_KEY, id);
      else window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Private browsing can refuse storage. The interview still works in one sitting.
    }
  }, []);
  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [ask, setAsk] = useState<AgentTurn | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [reply, setReply] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Derived, not stored: the options show if the person opened them, OR if the server is
  // re-asking because it could not read the last answer. Hiding the floor from the one
  // person who has just demonstrated they need it is how a conversation becomes a dead end.
  // Derivation beats a state-setting effect here — no cascading render, no stale flag when
  // the next turn lands.
  const showOptions = optionsOpen || ask?.retry === true;
  const [fallback, setFallback] = useState<FallbackQuestion[] | null>(null);
  const [fallbackAnswers, setFallbackAnswers] = useState<Record<number, number>>({});

  const headingRef = useRef<HTMLHeadingElement>(null);
  const agentTurnRef = useRef<HTMLDivElement>(null);

  // Index of the newest agent turn: focus follows it, so keyboard and screen reader users
  // land on the question rather than having to hunt back up the thread for it.
  let lastAgentIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "agent") {
      lastAgentIndex = i;
      break;
    }
  }

  useEffect(() => {
    if (phase === "contact") headingRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (lastAgentIndex >= 0) agentTurnRef.current?.focus();
  }, [lastAgentIndex]);

  const finish = useCallback(
    async (resultId: string) => {
      setPhase("calculating");
      await new Promise((r) => setTimeout(r, CALCULATING_MS));
      router.push(`/r/${resultId}`);
    },
    [router],
  );

  const receive = useCallback(
    (data: TurnResponse) => {
      if (data.status === "complete") {
        void finish(data.resultId);
        return;
      }
      if (data.status === "fallback") {
        // The turn budget is spent. Say so plainly and hand the rest to the form — the
        // alternative is guessing an answer, and one wrong answer in 25 moves the
        // archetype 15.4% of the time.
        setAsk(null);
        setFallback(data.questions);
        setTurns((t) => [
          ...t,
          {
            role: "agent",
            text: "Let's finish this the quick way — tap the answer that fits you best for each of these.",
          },
        ]);
        return;
      }
      setAsk(data.ask);
      setTurns((t) => [...t, { role: "agent", text: data.ask.text }]);
    },
    [finish],
  );

  /* ---------------- start ---------------- */

  const start = useCallback(
    async (parsed: { firstName: string; lastName: string; email: string; mobile: string; company: string | null }) => {
      setError(null);
      setPending(true);
      setPhase("thread");
      try {
        const data = await post<StartResponse>("/api/interview/start", {
          contact: parsed,
          event: event ?? null,
          teamSlug: teamSlug ?? null,
        });
        setDraftId(data.draftId);
        setAsk(data.ask);
        setTurns([{ role: "agent", text: data.ask.text }]);
      } catch (e) {
        const err = e instanceof InterviewError ? e : new InterviewError("Something went wrong.", true);
        setError({ message: err.message, retryable: err.retryable });
        // Their details are still in state, so going back to the form loses nothing.
        setPhase("contact");
      } finally {
        setPending(false);
      }
    },
    [event, teamSlug, setDraftId],
  );

  function submitContact(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    const parsed = contactSchema.safeParse({ ...contact, company: contact.company.trim() || undefined });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    void start(parsed.data);
  }

  /* ---------------- a turn ---------------- */

  const send = useCallback(
    async (next: Attempt) => {
      if (!draftId || pending) return;
      setError(null);
      setAttempt(next);
      setReply("");
      setTurns((t) => [...t, { role: "person", text: next.personText }]);
      setPending(true);
      try {
        const data = await post<TurnResponse>("/api/interview/turn", { draftId, ...next.payload });
        receive(data);
      } catch (e) {
        const err = e instanceof InterviewError ? e : new InterviewError("Something went wrong.", true);
        // Roll the optimistic bubble back and give them their words again, editable. The
        // thread must never show a turn the server never accepted.
        setTurns((t) => t.slice(0, -1));
        if (next.payload.reply !== undefined) setReply(next.payload.reply);
        setError({ message: err.message, retryable: err.retryable });
      } finally {
        setPending(false);
      }
    },
    [draftId, pending, receive],
  );

  function sendTyped() {
    const text = reply.trim();
    if (!text || pending || !ask) return;
    void send({ payload: { reply: text }, personText: text });
  }

  function sendTap(optionIndex: number) {
    if (pending || !ask) return;
    void send({ payload: { tapped: optionIndex }, personText: ask.options[optionIndex] });
  }

  function retry() {
    if (!attempt || pending) return;
    void send(attempt);
  }

  /* ---------------- the fallback tap form ---------------- */

  const submitFallback = useCallback(
    async (formEvent: React.FormEvent) => {
      formEvent.preventDefault();
      if (!draftId || !fallback || pending) return;
      setError(null);
      setPending(true);
      try {
        // One question per round trip, in the order the server gave them. There is no bulk
        // endpoint: the server settles each tap against the first question still
        // outstanding, so the order is load-bearing and a batch would misassign answers.
        let resultId: string | null = null;
        for (const question of fallback) {
          const value = fallbackAnswers[question.index];
          if (value === undefined || value === null) continue;
          const data = await post<{ status: string; resultId?: string }>("/api/interview/turn", {
            draftId,
            tapped: value,
          });
          if (data.status === "complete" && data.resultId) resultId = data.resultId;
        }
        if (!resultId) throw new InterviewError("We could not finish that just then.", true);
        await finish(resultId);
      } catch (e) {
        const err = e instanceof InterviewError ? e : new InterviewError("Something went wrong.", true);
        // Their taps stay in state, so the retry is one button press.
        setError({ message: err.message, retryable: err.retryable });
      } finally {
        setPending(false);
      }
    },
    [draftId, fallback, fallbackAnswers, pending, finish],
  );

  /* ---------------- intro ---------------- */

  if (phase === "intro") {
    return (
      <div className={quiz.hero}>
        {intro}
        <button type="button" className="button button-block" onClick={() => setPhase("contact")}>
          {startLabel}
        </button>
      </div>
    );
  }

  /* ---------------- contact capture ---------------- */

  if (phase === "contact") {
    return (
      <form className={quiz.form} onSubmit={submitContact} noValidate>
        <h1 className={quiz.questionText} tabIndex={-1} ref={headingRef}>
          First, who are you?
        </h1>
        <p className="muted small">We use these details to send you your scorecard.</p>

        {error && (
          <p className="alert" role="alert">
            {error.message} Your details are still here — press Begin to try again.
          </p>
        )}

        <div className={quiz.formRow}>
          <Field
            id="firstName"
            label="First name"
            value={contact.firstName}
            error={errors.firstName}
            autoComplete="given-name"
            onChange={(v) => setContact({ ...contact, firstName: v })}
          />
          <Field
            id="lastName"
            label="Last name"
            value={contact.lastName}
            error={errors.lastName}
            autoComplete="family-name"
            onChange={(v) => setContact({ ...contact, lastName: v })}
          />
        </div>
        <Field
          id="email"
          label="Email"
          type="email"
          inputMode="email"
          value={contact.email}
          error={errors.email}
          autoComplete="email"
          onChange={(v) => setContact({ ...contact, email: v })}
        />
        <Field
          id="mobile"
          label="Mobile"
          type="tel"
          inputMode="tel"
          value={contact.mobile}
          error={errors.mobile}
          autoComplete="tel"
          onChange={(v) => setContact({ ...contact, mobile: v })}
        />
        <Field
          id="company"
          label="Company (optional)"
          value={contact.company}
          error={errors.company}
          autoComplete="organization"
          required={false}
          onChange={(v) => setContact({ ...contact, company: v })}
        />

        <button type="submit" className="button button-block" disabled={pending}>
          {pending ? "Starting…" : "Begin"}
        </button>
      </form>
    );
  }

  /* ---------------- calculating ---------------- */

  if (phase === "calculating") {
    return (
      <div className={quiz.calculating} role="status" aria-live="polite">
        <div className={quiz.spinner} aria-hidden="true" />
        <p>Calculating your archetype…</p>
      </div>
    );
  }

  /* ---------------- the thread ---------------- */

  const percent = Math.round((ask?.progress ?? (fallback ? 1 : 0)) * 100);
  const options = ask?.options ?? [];
  const fallbackComplete = fallback ? fallback.every((q) => fallbackAnswers[q.index] !== undefined) : false;

  return (
    <div className={styles.shell}>
      {/* Unlabelled by design: no count, no percentage, no "N of 25". */}
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={styles.progressBar} style={{ width: `${percent}%` }} />
      </div>

      {/* The thread is a polite live region AND focus moves to the newest agent turn. A
          screen reader will hear the question twice, which is the trade we want: the live
          region covers people who have left focus in the textarea, and the focus move is
          what lets a keyboard user get back to the question they are answering. */}
      <ol className={styles.thread} aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
        {turns.map((turn, i) => (
          <li key={i} className={turn.role === "agent" ? styles.agentRow : styles.personRow}>
            <div
              className={turn.role === "agent" ? styles.agentBubble : styles.personBubble}
              tabIndex={turn.role === "agent" ? -1 : undefined}
              ref={turn.role === "agent" && i === lastAgentIndex ? agentTurnRef : undefined}
            >
              <span className="sr-only">{turn.role === "agent" ? "Interviewer said: " : "You said: "}</span>
              {turn.text}
            </div>
          </li>
        ))}

        {pending && (
          <li className={styles.agentRow}>
            <div className={styles.typing}>
              <span className="sr-only">Thinking…</span>
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.dot} aria-hidden="true" />
            </div>
          </li>
        )}
      </ol>

      {error && (
        <p className="alert" role="alert">
          {error.message}{" "}
          {error.retryable ? "Nothing is lost — your answers so far are saved." : "Please start again from the top."}{" "}
          {error.retryable && attempt && (
            <button type="button" className={styles.retry} onClick={retry} disabled={pending}>
              Try again
            </button>
          )}
        </p>
      )}

      {/* ---- the turn budget ran out: finish on the plain tap form ---- */}
      {fallback && (
        <form className={styles.fallback} onSubmit={submitFallback}>
          {fallback.map((question) => (
            <fieldset key={question.index} className={styles.fallbackQuestion}>
              <legend className={styles.fallbackLegend}>{question.text}</legend>
              <div className={quiz.options}>
                {question.options.map((option, optionIndex) => (
                  <label key={optionIndex} className={quiz.option}>
                    <input
                      type="radio"
                      name={`q${question.index}`}
                      value={optionIndex}
                      checked={fallbackAnswers[question.index] === optionIndex}
                      onChange={() => setFallbackAnswers((a) => ({ ...a, [question.index]: optionIndex }))}
                    />
                    <span className={quiz.optionKey} aria-hidden="true">
                      {OPTION_KEYS[optionIndex]}
                    </span>
                    <span className={quiz.optionText}>{option}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <button type="submit" className="button button-block" disabled={!fallbackComplete || pending}>
            {pending ? "Saving…" : "See my archetype"}
          </button>
        </form>
      )}

      {/* ---- the composer: type, or tap. The tap-out is always one press away. ---- */}
      {!fallback && (
        <div className={styles.composer}>
          <div className={styles.tapOut}>
            <button
              type="button"
              className={styles.tapToggle}
              aria-expanded={showOptions}
              aria-controls="interview-options"
              onClick={() => setOptionsOpen((open) => !open)}
            >
              {showOptions ? "Hide the answers" : "Or choose an answer"}
            </button>
            <div id="interview-options" className={styles.tiles} hidden={!showOptions}>
              {options.map((option, optionIndex) => (
                <button
                  key={optionIndex}
                  type="button"
                  className={styles.tile}
                  disabled={pending || !ask}
                  onClick={() => sendTap(optionIndex)}
                >
                  <span className={styles.tileKey} aria-hidden="true">
                    {OPTION_KEYS[optionIndex]}
                  </span>
                  <span className={styles.tileText}>{option}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.inputRow}>
            <label htmlFor="interview-reply" className="sr-only">
              Your answer
            </label>
            <textarea
              id="interview-reply"
              className={styles.input}
              rows={2}
              value={reply}
              maxLength={INTERVIEW_LIMITS.maxReplyChars}
              placeholder="Answer in your own words…"
              disabled={pending || !ask}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a new line. IME composition must never
                // send: in-flight candidate text would be submitted as the answer.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendTyped();
                }
              }}
            />
            <button
              type="button"
              className="button"
              onClick={sendTyped}
              disabled={pending || !ask || reply.trim().length === 0}
            >
              Send
            </button>
          </div>
          <p className="muted xs">Press Enter to send, Shift + Enter for a new line.</p>
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  error,
  onChange,
  type = "text",
  inputMode,
  autoComplete,
  required = true,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "email" | "tel" | "text";
  autoComplete?: string;
  required?: boolean;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={value}
        required={required}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
