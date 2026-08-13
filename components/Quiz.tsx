"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientQuestion } from "@/lib/scoring";
import { contactSchema, fieldErrors } from "@/lib/validation";
import styles from "./quiz.module.css";

/**
 * The whole quiz lives in this component's React state.
 *
 * Deliberately: no persistence, no autosave, no network calls until submit. A refresh
 * restarts the quiz — accepted trade-off that keeps 1000 concurrent takers entirely off
 * the database until they finish.
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
const AUTO_ADVANCE_MS = 240;
const CALCULATING_MS = 1400;

type Step = { kind: "intro" } | { kind: "contact" } | { kind: "question"; index: number } | { kind: "calculating" };

export type QuizProps = {
  questions: ClientQuestion[];
  /** Entry context, carried through to the server at submit time for attribution. */
  event?: string | null;
  teamSlug?: string | null;
  /** Hero copy, rendered by the server so the entry page is static and instant. */
  intro: React.ReactNode;
  startLabel?: string;
};

export default function Quiz({ questions, event, teamSlug, intro, startLabel = "Start the quiz" }: QuizProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "intro" });
  const [contact, setContact] = useState<ContactState>(EMPTY_CONTACT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<(number | null)[]>(() => questions.map(() => null));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const keyboardNav = useRef(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearAdvance() {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }

  // Never leave an auto-advance timer running after unmount.
  useEffect(() => () => clearAdvance(), []);

  // Move focus to the new question so screen readers and keyboards follow the flow.
  useEffect(() => {
    if (step.kind === "question" || step.kind === "contact") headingRef.current?.focus();
  }, [step]);

  const submit = useCallback(
    async (finalAnswers: number[]) => {
      setSubmitting(true);
      setSubmitError(null);
      setStep({ kind: "calculating" });
      const startedAt = Date.now();
      try {
        const response = await fetch("/api/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contact: { ...contact, company: contact.company.trim() || undefined },
            answers: finalAnswers,
            event: event ?? undefined,
            teamSlug: teamSlug ?? undefined,
          }),
        });
        const data = (await response.json().catch(() => null)) as { resultId?: string; error?: string } | null;
        if (!response.ok || !data?.resultId) {
          throw new Error(data?.error || "We could not save your answers just then.");
        }
        // Hold the transition for a beat so the reveal does not flash past.
        const elapsed = Date.now() - startedAt;
        if (elapsed < CALCULATING_MS) await new Promise((r) => setTimeout(r, CALCULATING_MS - elapsed));
        router.push(`/r/${data.resultId}`);
      } catch (error) {
        // Answers are still in state; the taker can retry without losing anything.
        setSubmitError(error instanceof Error ? error.message : "Something went wrong.");
        setStep({ kind: "question", index: questions.length - 1 });
        setSubmitting(false);
      }
    },
    [contact, event, teamSlug, questions.length, router],
  );

  function startQuiz(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    const parsed = contactSchema.safeParse({ ...contact, company: contact.company.trim() || undefined });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setStep({ kind: "question", index: 0 });
  }

  function choose(index: number, optionIndex: number) {
    const next = [...answers];
    next[index] = optionIndex;
    setAnswers(next);
    if (keyboardNav.current) return; // arrow-key browsing should not skip the question
    clearAdvance();
    advanceTimer.current = setTimeout(() => advance(index, next), AUTO_ADVANCE_MS);
  }

  function advance(index: number, current: (number | null)[]) {
    clearAdvance();
    if (index < questions.length - 1) {
      setStep({ kind: "question", index: index + 1 });
      return;
    }
    if (current.every((a): a is number => a !== null)) void submit(current as number[]);
  }

  function back(index: number) {
    clearAdvance();
    setStep(index === 0 ? { kind: "contact" } : { kind: "question", index: index - 1 });
  }

  /* ---------------- intro ---------------- */

  if (step.kind === "intro") {
    return (
      <div className={styles.hero}>
        {intro}
        <button type="button" className="button button-block" onClick={() => setStep({ kind: "contact" })}>
          {startLabel}
        </button>
      </div>
    );
  }

  /* ---------------- contact capture ---------------- */

  if (step.kind === "contact") {
    return (
      <form className={styles.form} onSubmit={startQuiz} noValidate>
        <h1 className={styles.questionText} tabIndex={-1} ref={headingRef}>
          First, who are you?
        </h1>
        <p className="muted small">We use these details to send you your scorecard.</p>

        <div className={styles.formRow}>
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

        <button type="submit" className="button button-block">
          Begin — 25 questions
        </button>
      </form>
    );
  }

  /* ---------------- calculating ---------------- */

  if (step.kind === "calculating") {
    return (
      <div className={styles.calculating} role="status" aria-live="polite">
        <div className={styles.spinner} aria-hidden="true" />
        <p>Calculating your archetype…</p>
      </div>
    );
  }

  /* ---------------- questions ---------------- */

  const { index } = step;
  const question = questions[index];
  const selected = answers[index];
  const isLast = index === questions.length - 1;
  const complete = answers.every((a) => a !== null);

  return (
    <div>
      <div className={styles.progress}>
        <div className={styles.progressRow}>
          <span>
            {index + 1} of {questions.length}
          </span>
        </div>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={questions.length}
          aria-valuenow={index + 1}
          aria-label="Quiz progress"
        >
          <div className={styles.progressBar} style={{ width: `${((index + 1) / questions.length) * 100}%` }} />
        </div>
      </div>

      <div className={styles.question}>
        <h1 className={styles.questionText} tabIndex={-1} ref={headingRef}>
          {question.text}
        </h1>

        {submitError && (
          <p className="alert" role="alert">
            {submitError} Your answers are safe — choose an option and press {isLast ? "See my archetype" : "Next"} to
            try again.
          </p>
        )}

        <fieldset
          className={styles.options}
          onPointerDown={() => {
            keyboardNav.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key.startsWith("Arrow")) keyboardNav.current = true;
          }}
        >
          <legend className="sr-only">{question.text}</legend>
          {question.options.map((option, optionIndex) => (
            <label key={optionIndex} className={styles.option}>
              <input
                type="radio"
                name={`q${index}`}
                value={optionIndex}
                checked={selected === optionIndex}
                onChange={() => choose(index, optionIndex)}
              />
              <span className={styles.optionKey} aria-hidden="true">
                {OPTION_KEYS[optionIndex]}
              </span>
              <span className={styles.optionText}>{option}</span>
            </label>
          ))}
        </fieldset>

        <div className={styles.nav}>
          <button type="button" className={styles.back} onClick={() => back(index)}>
            Back
          </button>
          <button
            type="button"
            className="button"
            disabled={selected === null || submitting || (isLast && !complete)}
            onClick={() => advance(index, answers)}
          >
            {isLast ? "See my archetype" : "Next"}
          </button>
        </div>
      </div>
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
