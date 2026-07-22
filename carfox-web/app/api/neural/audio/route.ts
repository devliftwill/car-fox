import { NextResponse, type NextRequest } from "next/server";

/** Relays an utterance WAV to the GPU server's /humanaudio (drives the lips). */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData(); // { sessionid, file }
    const r = await fetch(`${NEURAL}/humanaudio`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(20000),
    });
    return NextResponse.json(await r.json().catch(() => ({})), { status: r.status });
  } catch (e) {
    console.error("neural audio proxy:", e);
    return NextResponse.json({ error: "audio relay failed" }, { status: 502 });
  }
}
