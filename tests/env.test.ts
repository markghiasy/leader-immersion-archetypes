import { afterEach, describe, expect, it } from "vitest";
import { assertProductionEnv, baseUrl, scorecardUrl } from "@/lib/env";

/**
 * The failure this guards against is silent: with BASE_URL unset, every permanent link
 * the app hands out points at localhost while the app itself looks completely healthy.
 * These tests exist so that stays impossible in production.
 */

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("baseUrl", () => {
  it("prefers BASE_URL and strips trailing slashes", () => {
    setEnv({ BASE_URL: "https://quiz.example.com///" });
    expect(baseUrl()).toBe("https://quiz.example.com");
  });

  it("falls back to VERCEL_URL when BASE_URL is unset", () => {
    setEnv({ BASE_URL: undefined, VERCEL_URL: "preview.vercel.app" });
    expect(baseUrl()).toBe("https://preview.vercel.app");
  });

  it("falls back to localhost outside production", () => {
    setEnv({ BASE_URL: undefined, VERCEL_URL: undefined, NODE_ENV: "development" });
    expect(baseUrl()).toBe("http://localhost:3000");
  });

  it("throws in production rather than silently emitting a localhost link", () => {
    setEnv({ BASE_URL: undefined, VERCEL_URL: undefined, NODE_ENV: "production" });
    expect(() => baseUrl()).toThrow(/BASE_URL is not set/);
    // The failure must reach anything that builds a permanent link, not just baseUrl().
    expect(() => scorecardUrl("abc123")).toThrow(/BASE_URL is not set/);
  });
});

describe("assertProductionEnv", () => {
  it("is a no-op outside production, however little is configured", () => {
    setEnv({ BASE_URL: undefined, VERCEL_URL: undefined, DATABASE_URL: undefined, NODE_ENV: "test" });
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("passes in production when configuration is complete", () => {
    setEnv({
      NODE_ENV: "production",
      BASE_URL: "https://quiz.example.com",
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
    });
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("accepts VERCEL_URL in place of BASE_URL", () => {
    setEnv({
      NODE_ENV: "production",
      BASE_URL: undefined,
      VERCEL_URL: "preview.vercel.app",
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
    });
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("refuses to start when BASE_URL is missing in production", () => {
    setEnv({
      NODE_ENV: "production",
      BASE_URL: undefined,
      VERCEL_URL: undefined,
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
    });
    expect(() => assertProductionEnv()).toThrow(/Refusing to start/);
    expect(() => assertProductionEnv()).toThrow(/BASE_URL is not set/);
  });

  it("reports every missing variable at once, not just the first", () => {
    setEnv({ NODE_ENV: "production", BASE_URL: undefined, VERCEL_URL: undefined, DATABASE_URL: undefined });
    try {
      assertProductionEnv();
      throw new Error("expected assertProductionEnv to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/BASE_URL is not set/);
      expect(message).toMatch(/DATABASE_URL is not set/);
    }
  });
});
