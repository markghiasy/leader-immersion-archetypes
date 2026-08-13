import { z } from "zod";
import { OPTIONS_PER_QUESTION, QUESTION_COUNT } from "./scoring";

/** nanoid(14) over the default URL-safe alphabet. */
export const publicIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{14}$/, "Not a valid link");

export const eventSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Not a valid event");

export const contactSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(80),
  lastName: z.string().trim().min(1, "Last name is required").max(80),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")).pipe(z.string().max(160)),
  mobile: z
    .string()
    .trim()
    .min(6, "Enter a valid mobile number")
    .max(32)
    .regex(/^[0-9+()\s-]+$/, "Enter a valid mobile number"),
  company: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v ? v : null)),
});

export const answersSchema = z
  .array(z.number().int().min(0).max(OPTIONS_PER_QUESTION - 1))
  .length(QUESTION_COUNT, `All ${QUESTION_COUNT} questions must be answered`);

export const submitSchema = z.object({
  contact: contactSchema,
  answers: answersSchema,
  /** Entry context. At most one is meaningful; a team link wins if both are somehow sent. */
  event: eventSlugSchema.nullish(),
  teamSlug: publicIdSchema.nullish(),
});

export type SubmitPayload = z.infer<typeof submitSchema>;
export type Contact = z.infer<typeof contactSchema>;

export const emailScorecardSchema = z.object({
  resultId: publicIdSchema,
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")).pipe(z.string().max(160)),
});

/**
 * Flatten a zod error into `{ field: message }` for the client form.
 *
 * `stripPrefix` removes a wrapper segment so the server's keys match the form's input
 * names: the API validates `{ contact: { email } }` but the form only knows `email`.
 */
export function fieldErrors(error: z.ZodError, stripPrefix?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = [...issue.path];
    if (stripPrefix && path[0] === stripPrefix) path.shift();
    const key = path.join(".") || "form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
