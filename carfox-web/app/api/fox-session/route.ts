import { NextResponse } from "next/server";

/**
 * Creates a LemonSlice self-managed session (Daily transport, LemonSlice-hosted room)
 * driven by the Car Fox image. Keys stay server-side; the browser gets only what it needs.
 * NOTE: geminiKey is returned for local testing convenience — move Gemini auth to
 * ephemeral tokens before shipping publicly.
 */
export async function POST() {
  const key = process.env.LEMONSLICE_API_KEY;
  const gemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key || !gemini) {
    return NextResponse.json({ error: "Missing LEMONSLICE_API_KEY or GEMINI_API_KEY" }, { status: 500 });
  }

  const r = await fetch("https://lemonslice.com/api/liveai/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      agent_image_url:
        "https://play-lh.googleusercontent.com/0Qs57BBcxidJ8g3K3UD4ZvYZ1VFHxUGYX_m08UpaJXpnTIIO65ZmvX4-MjOedphk5120_NUVKQw8kniMl9j8HMU",
      agent_prompt: "a friendly cartoon fox mascot talking, expressive, upbeat",
      transport_type: "daily",
      idle_timeout: 120,
    }),
  });

  if (!r.ok) {
    const detail = await r.text();
    return NextResponse.json({ error: "LemonSlice session failed", detail }, { status: r.status });
  }

  const session = await r.json(); // { session_id, room_url, control_url }
  return NextResponse.json({ ...session, geminiKey: gemini });
}

export async function DELETE(req: Request) {
  const key = process.env.LEMONSLICE_API_KEY!;
  const { control_url } = await req.json();
  if (control_url && control_url.startsWith("https://lemonslice.com/")) {
    await fetch(control_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ event: "terminate" }),
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
