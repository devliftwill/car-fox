import { NextResponse, type NextRequest } from "next/server";

/**
 * Relays Avatar-generation to the GPU server (LiveTalking avatar-task API):
 * your uploaded/recorded clip becomes a full MuseTalk avatar server-side.
 *
 *   POST multipart {video, avatar_id} → creates the generation task
 *   GET  ?task=<id>                   → {status, progress, error_msg}
 */
const NEURAL = (process.env.FOX_NEURAL_URL ?? "http://136.113.13.127:8010").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  try {
    const inForm = await req.formData();
    const video = inForm.get("video");
    const avatarId = String(inForm.get("avatar_id") ?? "");
    if (!(video instanceof File) || !avatarId) {
      return NextResponse.json({ error: "video file and avatar_id required" }, { status: 400 });
    }
    const fd = new FormData();
    fd.append("model", "musetalk");
    fd.append("version", "v15");
    fd.append("avatar_id", avatarId);
    fd.append("video_file", video, video.name || "clip.webm");
    const r = await fetch(`${NEURAL}/api/avatar/task`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(60000),
    });
    return NextResponse.json(await r.json().catch(() => ({})), { status: r.status });
  } catch (e) {
    console.error("neural avatar create proxy:", e);
    return NextResponse.json({ error: "GPU server unreachable" }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const task = req.nextUrl.searchParams.get("task");
  if (!task) return NextResponse.json({ error: "task param required" }, { status: 400 });
  try {
    const r = await fetch(`${NEURAL}/api/avatar/task/${encodeURIComponent(task)}`, {
      signal: AbortSignal.timeout(10000),
    });
    return NextResponse.json(await r.json().catch(() => ({})), { status: r.status });
  } catch (e) {
    console.error("neural avatar status proxy:", e);
    return NextResponse.json({ error: "GPU server unreachable" }, { status: 502 });
  }
}
