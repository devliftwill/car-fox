import { NextResponse, type NextRequest } from "next/server";

/** Barge-in: flush the GPU server's audio queue for this session. */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");
const NEURAL_DITTO = (process.env.FOX_NEURAL_DITTO_URL ?? `${NEURAL}/ditto`).replace(/\/$/, "");

export async function POST(req: NextRequest) {
  try {
    const { engine, ...body } = await req.json();
    const base = engine === "ditto" ? NEURAL_DITTO : NEURAL;
    const r = await fetch(`${base}/interrupt_talk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return NextResponse.json(await r.json().catch(() => ({})), { status: r.status });
  } catch (e) {
    console.error("neural interrupt proxy:", e);
    return NextResponse.json({ error: "interrupt relay failed" }, { status: 502 });
  }
}
