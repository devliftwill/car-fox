import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";

/**
 * Proxies to the warm fox daemon (fox-agent/fox_daemon.py on :7788), which
 * keeps Python + pipecat imports loaded so a call starts in a few seconds
 * instead of ~15. The daemon costs nothing while idle — LemonSlice only
 * bills while a session is open.
 *
 * GET  ?warm=1  -> ensure the daemon is running (fire-and-forget from the UI)
 * POST {vehicle} -> start a session, returns {room_url}
 * DELETE         -> stop the current session
 */

const DAEMON = "http://127.0.0.1:7788";
const AGENT_DIR = path.join(process.cwd(), "..", "fox-agent");
const PYTHON = path.join(AGENT_DIR, ".venv", "bin", "python");
const DAEMON_SCRIPT = path.join(AGENT_DIR, "fox_daemon.py");

async function daemonAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<boolean> {
  if (await daemonAlive()) return true;
  const child = spawn(PYTHON, [DAEMON_SCRIPT], {
    cwd: AGENT_DIR,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Wait for it to come up (imports take a few seconds on first boot).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await daemonAlive()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("warm")) {
    const ok = await ensureDaemon();
    return NextResponse.json({ warm: ok });
  }
  return NextResponse.json({ ok: await daemonAlive() });
}

export async function POST(req: Request) {
  const { vehicle } = await req.json().catch(() => ({}) as { vehicle?: string });

  if (!(await ensureDaemon())) {
    return NextResponse.json(
      { error: "Fox daemon failed to start — check fox-agent/fox_daemon.log" },
      { status: 500 }
    );
  }

  try {
    const r = await fetch(`${DAEMON}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicle: vehicle ?? null }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json(
      { error: "Fox daemon did not respond: " + (e instanceof Error ? e.message : String(e)) },
      { status: 504 }
    );
  }
}

export async function DELETE() {
  try {
    await fetch(`${DAEMON}/stop`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch {
    /* daemon not running = nothing to stop */
  }
  return NextResponse.json({ ok: true });
}
