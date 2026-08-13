import type { NextConfig } from "next";

/**
 * Host-neutral by design.
 *
 * `output: "standalone"` produces a self-contained server bundle for the container image
 * (see Dockerfile). It is opt-in via BUILD_STANDALONE so that a platform build which does
 * its own packaging is left alone — set it in the Docker build, nowhere else.
 */
const nextConfig: NextConfig = {
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  /**
   * Dev only, and only needed to test on a phone: `next dev` blocks cross-origin requests
   * to /_next/static from a non-localhost host, which leaves the page rendered but never
   * hydrated — every button silently does nothing. Add your machine's LAN IP here to run
   * the two-device invite flow locally. Has no effect on production builds.
   */
  allowedDevOrigins: ["192.168.1.61"],
  headers: async () => [
    {
      // Scorecards and invite links are unguessable, not secret. Keep them out of indexes.
      source: "/:path*",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
  ],
};

export default nextConfig;
