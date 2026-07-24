import { NextResponse, type NextRequest } from "next/server";

/** Relays SmallWebRTC signaling to the Pipecat character bot on the GPU VM. */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");
const PIPECAT = (process.env.FOX_PIPECAT_URL ?? `${NEURAL}/pipecat`).replace(/\/$/, "");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const r = await fetch(`${PIPECAT}/api/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    console.error("pipecat offer proxy:", e);
    return NextResponse.json({ error: "character bot unreachable" }, { status: 502 });
  }
}
