/**
 * Site access gate — shared helpers for the passcode wall.
 *
 * The passcode itself lives only on the server (SITE_PASSCODE env var). We never
 * store it in a cookie. Instead the unlock endpoint sets a cookie holding an
 * opaque token derived from the passcode, and the middleware recomputes the same
 * token to verify. An attacker who doesn't know the passcode can't forge it.
 *
 * Uses Web Crypto (crypto.subtle) so it runs in both the Edge middleware and the
 * Node API route without changes.
 */
export const AUTH_COOKIE = "carfox_access";

/** Opaque token derived from the passcode. Same input → same output. */
export async function gateToken(passcode: string): Promise<string> {
  const data = new TextEncoder().encode(`carfox-gate:v1:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
