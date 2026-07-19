"""Car Fox — pipecat sidecar.

Official LemonSlice path: this bot creates the LemonSlice session (LemonSlice
hosts the Daily room — no Daily/LiveKit accounts), joins it, listens to the
visitor's mic from the room, thinks/speaks with Gemini Live (Puck voice), and
the LemonSlice avatar lip-syncs the reply.

Credit protections (LemonSlice bills ~20 credits/min of open session):
  - exits when the visitor leaves the room
  - exits if no visitor joins within 90s
  - LemonSlice idle_timeout 120s as a server-side backstop
  - hard cap: exits after MAX_SESSION_SECS no matter what

The room URL is written to room.json so the web app can join the same room.

Run:  .venv/bin/python fox_bot.py [--vehicle <slug>]
"""

import argparse
import asyncio
import json
import os
from pathlib import Path

import aiohttp
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

MAX_SESSION_SECS = 600  # absolute ceiling per call
NO_VISITOR_TIMEOUT_SECS = 90  # exit if nobody ever joins

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

# Per-page focus blocks, keyed by the web app's vehicle slugs.
VEHICLES = {
    "2023-bmw-m5": "the 2023 BMW M5 ($83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, 10 service records, Newport Beach)",
    "2024-bmw-m4-competition": "the 2024 BMW M4 Competition ($70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys)",
    "2023-mercedes-amg-gt-63": "the 2023 Mercedes-AMG GT 63 ($116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, $22,035 below CARFAX value, Newport Beach)",
    "2026-porsche-panamera-gts": "the 2026 Porsche Panamera GTS ($184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified pre-owned, Pasadena — the flagship)",
    "2018-chevrolet-camaro-ss": "the 2018 Chevrolet Camaro SS 1SS ($29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported — disclose honestly, suggest an inspection, 3+ owners, North Hollywood)",
    "2015-ford-mustang-gt": "the 2015 Ford Mustang GT ($18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, 6-speed manual, Bell CA)",
}

ROOM_FILE = Path(__file__).parent / "room.json"


def capture_room_url():
    """Write the LemonSlice-hosted room URL where the web app can find it."""
    orig = LemonSliceApi.create_session

    async def patched(self, *args, **kwargs):
        resp = await orig(self, *args, **kwargs)
        ROOM_FILE.write_text(json.dumps(resp))
        logger.info(f"🦊 FOX ROOM: {resp.get('room_url')}")
        return resp

    LemonSliceApi.create_session = patched


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vehicle", default=None, help="vehicle slug the visitor is viewing")
    args = parser.parse_args()

    logger.add(Path(__file__).parent / "fox_bot.log", rotation="2 MB", retention=2)

    system_prompt = SYSTEM_PROMPT
    focus = VEHICLES.get(args.vehicle or "")
    if focus:
        system_prompt += (
            f"\n\nCURRENT PAGE CONTEXT — the visitor is RIGHT NOW looking at {focus}. "
            "Assume questions are about THIS car unless they say otherwise."
        )

    capture_room_url()
    ROOM_FILE.unlink(missing_ok=True)

    lemonslice_key = os.environ["LEMONSLICE_API_KEY"]
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ["GOOGLE_API_KEY"]

    async with aiohttp.ClientSession() as session:
        transport = LemonSliceTransport(
            bot_name="Car Fox Brain",
            session=session,
            api_key=lemonslice_key,
            session_request=LemonSliceNewSessionRequest(
                agent_image_url=FOX_IMAGE,
                agent_prompt="a friendly cartoon fox mascot talking, expressive, upbeat",
                idle_timeout=120,
            ),
            params=LemonSliceParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )

        llm = GeminiLiveLLMService(
            api_key=gemini_key,
            settings=GeminiLiveLLMService.Settings(
                model="models/gemini-3.1-flash-live-preview",
                voice="Puck",
                system_instruction=system_prompt,
            ),
            # Stay quiet until the visitor actually joins the room.
            inference_on_context_initialization=False,
        )

        context = LLMContext()
        context_aggregator = LLMContextAggregatorPair(context)

        pipeline = Pipeline(
            [
                transport.input(),
                context_aggregator.user(),
                llm,
                transport.output(),
                context_aggregator.assistant(),
            ]
        )

        task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))

        visitor_joined = asyncio.Event()

        @transport.event_handler("on_avatar_connected")
        async def on_avatar_connected(transport, participant):
            logger.info(f"🦊 Avatar connected: {participant.get('id')}")

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, participant):
            logger.info(f"👤 Visitor connected: {participant.get('id')}")
            visitor_joined.set()
            greet = "A visitor just joined the call — greet them in one short energetic sentence"
            if focus:
                greet += f" and offer to talk about {focus.split('(')[0].strip()}"
            context.add_message({"role": "user", "content": greet + "!"})
            await task.queue_frames([LLMRunFrame()])

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, participant):
            logger.info("👋 Visitor left — ending session to save credits.")
            await task.cancel()

        async def watchdogs():
            try:
                await asyncio.wait_for(visitor_joined.wait(), timeout=NO_VISITOR_TIMEOUT_SECS)
            except asyncio.TimeoutError:
                logger.info("⏱ No visitor joined — ending session to save credits.")
                await task.cancel()
                return
            await asyncio.sleep(MAX_SESSION_SECS)
            logger.info("⏱ Hard session cap reached — ending session to save credits.")
            await task.cancel()

        watchdog_task = asyncio.create_task(watchdogs())

        runner = PipelineRunner()
        try:
            await runner.run(task)
        finally:
            watchdog_task.cancel()
            ROOM_FILE.unlink(missing_ok=True)
            logger.info("Session ended cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
