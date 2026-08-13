import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP Basic Auth for /admin (and its CSV export).
 *
 * Next 16 calls this file `proxy.ts`; it is the same request-interception convention
 * previously named `middleware.ts`, and it runs identically under `next start` on any
 * Node host, so it does not tie us to Vercel.
 */
export const config = {
  matcher: ["/admin/:path*"],
};

const REALM = 'Basic realm="Leader Archetype admin", charset="UTF-8"';

export function proxy(request: NextRequest) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;

  // Fail closed: with no credentials configured the dashboard is not reachable at all.
  if (!user || !pass) {
    return new NextResponse("Admin is not configured.", { status: 503 });
  }

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    const separator = decoded.indexOf(":");
    if (separator !== -1) {
      const suppliedUser = decoded.slice(0, separator);
      const suppliedPass = decoded.slice(separator + 1);
      if (safeEqual(suppliedUser, user) && safeEqual(suppliedPass, pass)) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": REALM },
  });
}

/** Constant-time-ish comparison so the response time does not leak the credentials. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
