import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emailTokens } from "@/lib/email-theme";
import { renderScorecardEmail } from "@/lib/email";
import { allArchetypes } from "@/lib/content";

const themeCss = readFileSync(path.join(process.cwd(), "app/theme.css"), "utf8");

function tokenValue(name: string): string | null {
  const match = themeCss.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

describe("theming", () => {
  it("keeps the email's mirrored tokens identical to theme.css", () => {
    // A rebrand edits theme.css only; this stops the email quietly keeping the old palette.
    for (const [name, value] of Object.entries(emailTokens)) {
      expect(tokenValue(name), `${name} is missing from app/theme.css`).not.toBeNull();
      expect(tokenValue(name), `${name} has drifted from app/theme.css`).toBe(value);
    }
  });

  it("declares every token THEMING.md promises", () => {
    const documented = readFileSync(path.join(process.cwd(), "THEMING.md"), "utf8");
    const declared = [...themeCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(30);
    for (const token of new Set(declared)) {
      expect(documented, `${token} is not documented in THEMING.md`).toContain(token);
    }
  });

  it("uses no raw colours outside theme.css", () => {
    const globals = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(globals).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("scorecard email", () => {
  it("reproduces the scorecard content and links to the permanent URL", () => {
    for (const archetype of allArchetypes) {
      const totals = [3, 7, 2, 1, 4, 5, 0, 2];
      const { subject, html, text } = renderScorecardEmail({
        firstName: "Sam",
        profile: archetype.profile,
        resultId: "abcdefghijklmn",
        totals,
      });
      // The profile shape travels with the email in place of the emblem.
      expect(html).toContain("Your profile shape");
      for (const other of allArchetypes) expect(html).toContain(other.name.replace(/^The /, ""));
      expect(subject).toContain(archetype.name);
      expect(html).toContain(`${archetype.profile}. ${archetype.name}`);
      expect(html).toContain("/r/abcdefghijklmn");
      for (const strength of archetype.strengths) expect(html).toContain(strength);
      for (const watchout of archetype.watchouts) expect(html).toContain(watchout);
      expect(text).toContain(archetype.description);
    }
  });

  it("escapes names so a quirky first name cannot inject markup", () => {
    const { html } = renderScorecardEmail({
      firstName: '<script>alert("x")</script>',
      profile: 1,
      resultId: "abcdefghijklmn",
      totals: [1, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
