import { customAlphabet } from "nanoid";

/**
 * 14 characters over nanoid's URL-safe alphabet (64 symbols) ≈ 84 bits of entropy.
 * Result URLs and invite links are public-but-unguessable; the id IS the access control,
 * so never shorten this.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
export const PUBLIC_ID_LENGTH = 14;

const generate = customAlphabet(ALPHABET, PUBLIC_ID_LENGTH);

export function publicId(): string {
  return generate();
}
