import { NextResponse } from "next/server";
import crypto from "node:crypto";

/**
 * Self-waking GPU: called by the Avatar Lab on page load.
 *
 *   ready    → the lip-sync server is answering; proceed
 *   starting → the VM was off (or booting) and has been started; poll again
 *
 * Auth: a dedicated GCP service account (fox-wake@) whose base64 JSON key
 * lives in FOX_WAKE_SA_KEY. The VM stops itself after ~15 idle minutes
 * (see neural-mouth runbook), so idle cost is pennies — this route brings
 * it back in ~90s when someone shows up.
 */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");
const PROJECT = "otava-469016";
const ZONE = process.env.FOX_NEURAL_ZONE ?? "us-central1-b";
const INSTANCE = "fox-neural-mouth";

const b64url = (input: Buffer | string) =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function gcpAccessToken(): Promise<string> {
  const raw = process.env.FOX_WAKE_SA_KEY;
  if (!raw) throw new Error("FOX_WAKE_SA_KEY not configured");
  const key = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(
      JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/compute",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      })
    );
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
  const jwt = `${unsigned}.${b64url(signature)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token exchange failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

export async function GET() {
  // Fast path: server already answering?
  try {
    const r = await fetch(`${NEURAL}/api/avatar/list`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return NextResponse.json({ status: "ready" });
  } catch {}

  try {
    const token = await gcpAccessToken();
    const base = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${INSTANCE}`;
    const inst = await fetch(base, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json());
    const vm = inst.status as string;
    if (vm === "TERMINATED" || vm === "STOPPED" || vm === "SUSPENDED") {
      await fetch(`${base}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      }).catch(() => {});
      return NextResponse.json({ status: "starting", vm });
    }
    // RUNNING but server not answering yet = model load; STOPPING = wait, next poll starts it
    return NextResponse.json({ status: "starting", vm });
  } catch (e) {
    console.error("wake:", e);
    return NextResponse.json({ status: "error", error: String(e).slice(0, 200) }, { status: 502 });
  }
}
