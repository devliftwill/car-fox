import { NextResponse, type NextRequest } from "next/server";

/**
 * Diagnostics passthrough for the self-hosted fox (read-only, GET).
 *
 *   /api/neural/diag?path=turns             per-turn delay attribution
 *   /api/neural/diag?path=trace             raw window trace + counters
 *   /api/neural/diag?path=recordings        list of session artefacts
 *   /api/neural/diag?path=recording/<name>  download one (mp4 or json)
 *
 * Every call records what the visitor actually received, so a "the mouth was
 * off / it cut out" report can be reviewed instead of reproduced by guesswork.
 */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");
const PIPECAT = (process.env.FOX_PIPECAT_URL ?? `${NEURAL}/pipecat`).replace(/\/$/, "");

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("path") ?? "turns";
  const ok =
    ["turns", "trace", "recordings"].includes(requested) ||
    /^recording\/fox-session-[0-9]+\.(mp4|json)$/.test(requested);
  if (!ok) return NextResponse.json({ error: "unknown diagnostic" }, { status: 400 });

  try {
    const r = await fetch(`${PIPECAT}/api/${requested}`, { signal: AbortSignal.timeout(60000) });
    if (requested.startsWith("recording/")) {
      const name = requested.split("/")[1];
      return new NextResponse(await r.arrayBuffer(), {
        status: r.status,
        headers: {
          "Content-Type": name.endsWith(".mp4") ? "video/mp4" : "application/json",
          "Content-Disposition": `inline; filename="${name}"`,
        },
      });
    }
    return NextResponse.json(await r.json(), { status: r.status });
  } catch {
    return NextResponse.json({ error: "studio unreachable (it may be asleep)" }, { status: 502 });
  }
}
