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
