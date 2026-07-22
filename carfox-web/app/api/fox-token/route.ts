import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

/**
 * Mints a single-use ephemeral Gemini Live token for the browser fox call.
 *
 * The real API key never leaves the server (this replaces the old
 * /api/fox-session route, which returned the raw key to any visitor).
 * The token opens exactly one Live session, must be used within 60s, and the
 * session it opens dies after 30 minutes no matter what.
 */
export async function POST() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } });
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    return NextResponse.json({ token: token.name });
  } catch (e) {
    console.error("fox-token:", e);
    return NextResponse.json({ error: "Could not mint fox token" }, { status: 502 });
  }
}
