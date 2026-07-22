import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxies WebRTC signaling to the self-hosted GPU lip-sync server
 * (LiveTalking on the fox-neural-mouth VM). The page is HTTPS and the VM
 * speaks HTTP, so the browser can't call it directly — this hop can.
 * Media itself flows browser⇄VM over WebRTC, not through here.
 */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const r = await fetch(`${NEURAL}/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    console.error("neural offer proxy:", e);
    return NextResponse.json(
      { error: "Neural server unreachable — is the GPU VM running?" },
      { status: 502 }
    );
  }
}
