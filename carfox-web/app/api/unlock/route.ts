import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, gateToken } from "@/lib/gate";

/**
 * Verifies the submitted passcode and, on success, sets the httpOnly access
 * cookie that the middleware checks. A tiny delay on failure blunts brute-force
 * guessing without hurting the real user.
 */
export async function POST(req: NextRequest) {
  const passcode = process.env.SITE_PASSCODE;
  if (!passcode) {
    return NextResponse.json({ ok: false, error: "Gate not configured." }, { status: 500 });
  }

  let code = "";
  try {
    ({ code = "" } = await req.json());
  } catch {
    // malformed body → treated as wrong code below
  }

  if (code.trim() !== passcode) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ ok: false, error: "That code isn't right." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await gateToken(passcode), {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // allowed on http://localhost, required in production
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
