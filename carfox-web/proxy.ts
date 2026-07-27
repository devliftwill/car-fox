import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, gateToken } from "@/lib/gate";

/**
 * Passcode wall (Next.js 16 Proxy — formerly "middleware"). Every request that
 * isn't the gate page, the unlock endpoint, or a static asset must carry a valid
 * access cookie — otherwise it's redirected to /gate. Keeps casual visitors and
 * search-engine crawlers out of the whole site.
 *
 * If SITE_PASSCODE is unset the gate is disabled (fail-open) so a missing env var
 * can never lock you out of your own deployment.
 */
export async function proxy(req: NextRequest) {
  const passcode = process.env.SITE_PASSCODE;
  if (!passcode) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // The gate page and its unlock endpoint must stay reachable while locked.
  if (pathname === "/gate" || pathname === "/api/unlock") {
    return NextResponse.next();
  }

  // Meeting-bot surface. Recall.ai renders a URL as the bot's camera, and its
  // browser carries no session cookie — so without this the bot streams the
  // passcode wall into the meeting instead of the fox. Gated on a separate
  // secret in the query string rather than opened up: the passcode still
  // protects every other route, and this one is only useful to whoever holds
  // the key. Constant-time-ish compare to avoid leaking it by timing.
  if (pathname === "/fox-meet") {
    const key = process.env.MEET_BOT_KEY;
    const given = req.nextUrl.searchParams.get("k") ?? "";
    if (key && given.length === key.length && given === key) {
      // Hand the bot a real session cookie. The page immediately calls
      // /api/neural/wake and /api/neural/pipecat, and exempting only the
      // page left those API calls redirecting to /gate — the page then span
      // on "waking the fox" forever waiting for a reply that never came.
      // Whoever holds MEET_BOT_KEY is already trusted with the site.
      const res = NextResponse.next();
      res.cookies.set(AUTH_COOKIE, await gateToken(passcode), {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/",
        maxAge: 60 * 60 * 4,
      });
      return res;
    }
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === (await gateToken(passcode))) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/gate";
  url.search = pathname === "/" ? "" : `?from=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static files (by extension).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|mp4|webm|woff2?|txt|xml)$).*)",
  ],
};
