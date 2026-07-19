"""Car Fox warm daemon.

Keeps Python + pipecat imports warm (costs nothing while idle — LemonSlice
only bills while a session is open) and starts/stops fox sessions on demand:

  POST /start {"vehicle": slug|null}  -> {"room_url": ...}  (returned the
        moment LemonSlice creates the room — the browser joins while the
        avatar is still booting, overlapping the two waits)
  POST /stop                          -> {"ok": true}
  GET  /health                        -> {"ok": true, "active": bool}

Credit protections per session: visitor-left shutdown, 90s no-visitor
timeout, LemonSlice idle_timeout 120s, hard 600s cap.

The greeting is gated on BOTH the avatar being in the room AND the visitor
being connected, so the fox introduces himself the moment he appears instead
of standing there in awkward silence.
"""

import asyncio
import os
from pathlib import Path

import aiohttp
from aiohttp import web
from dotenv import load_dotenv
from loguru import logger

from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.transports.lemonslice.api import LemonSliceApi
from pipecat.transports.lemonslice.transport import (
    LemonSliceNewSessionRequest,
    LemonSliceParams,
    LemonSliceTransport,
)

load_dotenv()
load_dotenv(Path(__file__).parent.parent / "carfox-web" / ".env.local")

# Hosted platforms (Railway/Render/Fly) inject $PORT and expect 0.0.0.0.
# Locally this stays 7788 on 127.0.0.1 so nothing about dev changes.
PORT = int(os.environ.get("PORT", "7788"))
HOST = os.environ.get("FOX_DAEMON_HOST", "127.0.0.1" if "PORT" not in os.environ else "0.0.0.0")
# When set, every /start and /stop must present this in the X-Fox-Secret header.
# The Vercel /api/fox-room proxy forwards it; the daemon is otherwise public.
FOX_DAEMON_SECRET = os.environ.get("FOX_DAEMON_SECRET")
MAX_SESSION_SECS = 600
NO_VISITOR_TIMEOUT_SECS = 90

FOX_IMAGE = (
    "https://play-lh.googleusercontent.com/0Qs57BBcxidJ8g3K3UD4ZvYZ1VFHxUGYX_"
    "m08UpaJXpnTIIO65ZmvX4-MjOedphk5120_NUVKQw8kniMl9j8HMU"
)

SYSTEM_PROMPT = """You are the Car Fox, a quick-witted, upbeat cartoon fox mascot for a curated performance-car lot. Keep replies short and punchy (1-2 sentences), warm and playful, with the occasional fox pun. Never break character. If someone says "show me the Carfax," lean into it — you ARE the Car Fox.
IMPORTANT: Never repeat or echo the visitor's words back to them. Listen, then answer naturally in your own words. If you didn't catch something, ask them to say it again.
You know the lot's LIVE INVENTORY exactly (real vehicles, real CARFAX-listed history — never invent):
1) 2023 BMW M5 — $83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, 10 service records, Newport Beach.
2) 2024 BMW M4 Competition — $70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys.
3) 2023 Mercedes-AMG GT 63 — $116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, $22,035 below CARFAX value, Newport Beach.
4) 2026 Porsche Panamera GTS — $184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified pre-owned, Pasadena. The flagship.
5) 2018 Chevrolet Camaro SS 1SS — $29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported, 3+ owners — always disclose honestly and suggest an inspection. North Hollywood.
6) 2015 Ford Mustang GT — $18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, 6-speed manual, Bell CA."""

VEHICLES = {
    "2023-bmw-m5": "the 2023 BMW M5 ($83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, 10 service records, Newport Beach)",
    "2024-bmw-m4-competition": "the 2024 BMW M4 Competition ($70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys)",
    "2023-mercedes-amg-gt-63": "the 2023 Mercedes-AMG GT 63 ($116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, $22,035 below CARFAX value, Newport Beach)",
    "2026-porsche-panamera-gts": "the 2026 Porsche Panamera GTS ($184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified pre-owned, Pasadena — the flagship)",
    "2018-chevrolet-camaro-ss": "the 2018 Chevrolet Camaro SS 1SS ($29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported — disclose honestly, suggest an inspection, 3+ owners, North Hollywood)",
    "2015-ford-mustang-gt": "the 2015 Ford Mustang GT ($18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, 6-speed manual, Bell CA)",
}


class FoxSession:
    """One live fox call: pipeline + watchdogs + both-ready greeting gate."""

    def __init__(self, http: aiohttp.ClientSession, vehicle: str | None):
        self.http = http
        self.vehicle = vehicle
        self.room_url: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        self.task: PipelineTask | None = None
        self.runner_task: asyncio.Task | None = None

    async def start(self):
        focus = VEHICLES.get(self.vehicle or "")
        system_prompt = SYSTEM_PROMPT
        if focus:
            system_prompt += (
                f"\n\nCURRENT PAGE CONTEXT — the visitor is RIGHT NOW looking at {focus}. "
                "Assume questions are about THIS car unless they say otherwise."
            )

        # Capture room_url the moment LemonSlice creates the session.
        orig = LemonSliceApi.create_session
        me = self

        async def patched(api_self, *args, **kwargs):
            resp = await orig(api_self, *args, **kwargs)
            if not me.room_url.done():
                me.room_url.set_result(resp["room_url"])
            logger.info(f"🦊 room: {resp['room_url']}")
            return resp

        LemonSliceApi.create_session = patched

        transport = LemonSliceTransport(
            bot_name="Car Fox Brain",
            session=self.http,
            api_key=os.environ["LEMONSLICE_API_KEY"],
            session_request=LemonSliceNewSessionRequest(
                agent_image_url=FOX_IMAGE,
                agent_prompt="a friendly cartoon fox mascot talking, expressive, upbeat",
                idle_timeout=120,
            ),
            params=LemonSliceParams(audio_in_enabled=True, audio_out_enabled=True),
        )

        llm = GeminiLiveLLMService(
            api_key=os.environ.get("GEMINI_API_KEY") or os.environ["GOOGLE_API_KEY"],
            settings=GeminiLiveLLMService.Settings(
                model="models/gemini-3.1-flash-live-preview",
                voice="Puck",
                system_instruction=system_prompt,
            ),
            # MUST be True: with False, pipecat seeds the intro but never
            # triggers inference on Gemini 3 (it skips both turn_complete and
            # the send_realtime_input nudge Gemini 3 requires) — the fox goes
            # permanently mute. Boot stays silent regardless because the
            # context is empty until we add the intro at both-ready.
            inference_on_context_initialization=True,
        )

        context = LLMContext()
        aggregators = LLMContextAggregatorPair(context)
        pipeline = Pipeline(
            [
                transport.input(),
                aggregators.user(),
                llm,
                transport.output(),
                aggregators.assistant(),
            ]
        )
        task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
        self.task = task

        avatar_ready = asyncio.Event()
        visitor_ready = asyncio.Event()
        greeted = False

        async def maybe_greet():
            nonlocal greeted
            if greeted or not (avatar_ready.is_set() and visitor_ready.is_set()):
                return
            greeted = True
            # Seny-style kickoff: tell the model the call just connected and
            # that IT opens the conversation — the visitor's mic is muted
            # until this intro plays, so nothing can preempt it.
            intro = (
                "The visitor's call just connected and your video appeared on their screen. "
                "YOU speak first — right now. Open with one short, energetic Car Fox greeting: "
                "introduce yourself"
            )
            if focus:
                intro += f", and offer to tell them about {focus.split('(')[0].strip()} they're looking at"
            else:
                intro += ", and invite them to ask about any car on the lot"
            intro += ". One or two sentences, then pause for their reply."
            context.add_message({"role": "user", "content": intro})
            await task.queue_frames([LLMRunFrame()])
            logger.info("🎤 Intro queued (avatar + visitor both ready)")

        @transport.event_handler("on_avatar_connected")
        async def on_avatar(t, participant):
            logger.info("🦊 Avatar connected")
            avatar_ready.set()
            await maybe_greet()

        @transport.event_handler("on_client_connected")
        async def on_client(t, participant):
            logger.info("👤 Visitor connected")
            visitor_ready.set()
            await maybe_greet()

        @transport.event_handler("on_client_disconnected")
        async def on_client_left(t, participant):
            logger.info("👋 Visitor left — ending session to save credits.")
            await task.cancel()

        async def watchdogs():
            try:
                await asyncio.wait_for(visitor_ready.wait(), timeout=NO_VISITOR_TIMEOUT_SECS)
            except asyncio.TimeoutError:
                logger.info("⏱ No visitor — ending session.")
                await task.cancel()
                return
            await asyncio.sleep(MAX_SESSION_SECS)
            logger.info("⏱ Hard cap — ending session.")
            await task.cancel()

        async def run():
            watchdog = asyncio.create_task(watchdogs())
            try:
                runner = PipelineRunner(handle_sigint=False)
                await runner.run(task)
            finally:
                watchdog.cancel()
                logger.info("Session ended.")

        self.runner_task = asyncio.create_task(run())

    async def stop(self):
        if self.task:
            try:
                await self.task.cancel()
            except Exception:
                pass
        if self.runner_task:
            try:
                await asyncio.wait_for(self.runner_task, timeout=10)
            except Exception:
                pass


current: FoxSession | None = None
http_session: aiohttp.ClientSession | None = None


def _unauthorized(request: web.Request) -> bool:
    """True if a shared secret is configured and the request doesn't match it."""
    if not FOX_DAEMON_SECRET:
        return False
    return request.headers.get("X-Fox-Secret") != FOX_DAEMON_SECRET


async def handle_start(request: web.Request):
    global current
    if _unauthorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json() if request.can_read_body else {}
    vehicle = body.get("vehicle")

    if current is not None:
        await current.stop()
        current = None

    sess = FoxSession(http_session, vehicle)
    await sess.start()
    current = sess
    try:
        room_url = await asyncio.wait_for(asyncio.shield(sess.room_url), timeout=20)
    except asyncio.TimeoutError:
        await sess.stop()
        current = None
        return web.json_response({"error": "LemonSlice session timed out"}, status=504)
    return web.json_response({"room_url": room_url})


async def handle_stop(request: web.Request):
    global current
    if _unauthorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    if current is not None:
        await current.stop()
        current = None
    return web.json_response({"ok": True})


async def handle_health(request: web.Request):
    active = current is not None and current.runner_task and not current.runner_task.done()
    return web.json_response({"ok": True, "active": bool(active)})


async def main():
    global http_session
    logger.add(Path(__file__).parent / "fox_daemon.log", rotation="2 MB", retention=2)
    http_session = aiohttp.ClientSession()
    app = web.Application()
    app.router.add_post("/start", handle_start)
    app.router.add_post("/stop", handle_stop)
    app.router.add_get("/health", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()
    logger.info(f"🦊 Fox daemon warm on http://{HOST}:{PORT} — idle costs nothing.")
    await asyncio.Event().wait()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
