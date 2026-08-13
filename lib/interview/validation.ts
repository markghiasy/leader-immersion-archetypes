import { z } from "zod";
import { OPTIONS_PER_QUESTION } from "@/lib/scoring";
import { contactSchema, eventSlugSchema, publicIdSchema } from "@/lib/validation";
import { INTERVIEW_LIMITS } from "./contract";

/**
 * Wire validation for the two interview endpoints.
 *
 * The shapes are `StartRequest` and `TurnRequest` from ./contract — this module only
 * decides what a well-formed one looks like on the wire. Nothing here is re-modelled: the
 * contact block is the SAME `contactSchema` the tap form posts to /api/submit, because the
 * interview and the form write to the same `responses` row and a person who fails
 * validation on one must fail it on the other.
 */

/**
 * A draft id is nanoid(14), the same alphabet and length as every other public id in the
 * app, so it gets the same schema. It is a bearer handle: whoever holds it can add to that
 * draft, which is why the turn endpoint's rate limit is keyed on it.
 */
export const draftIdSchema = publicIdSchema;

export const startRequestSchema = z.object({
  contact: contactSchema,
  /** Entry context. A team link wins over an event slug — see /api/submit. */
  event: eventSlugSchema.nullish(),
  teamSlug: publicIdSchema.nullish(),
});

/**
 * One move by the person: they either typed or they tapped.
 *
 * Exactly one, never both, never neither. Both would be ambiguous — the tap is an explicit
 * confirmation and the text is evidence to be extracted, and there is no defensible rule
 * for which wins. Neither is a client bug, and answering it with a turn would burn a turn
 * out of the budget for nothing.
 */
export const turnRequestSchema = z
  .object({
    draftId: draftIdSchema,
    reply: z
      .string()
      .trim()
      .min(1, "Say a little more than that")
      // Long enough for a genuinely rambling answer; the ceiling exists so one paste
      // cannot blow out an extraction call, not to police how much people say.
      .max(INTERVIEW_LIMITS.maxReplyChars, "That is longer than we can take in one go — could you trim it?")
      .optional(),
    tapped: z
      .number()
      .int()
      .min(0)
      .max(OPTIONS_PER_QUESTION - 1, "That is not one of the options")
      .optional(),
  })
  .refine((v) => (v.reply === undefined) !== (v.tapped === undefined), {
    message: "Send either a reply or a tapped option.",
  });

export type StartPayload = z.infer<typeof startRequestSchema>;
export type TurnPayload = z.infer<typeof turnRequestSchema>;
