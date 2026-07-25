"""carfox Pipecat bot — the LemonSlice-architecture character call.

FastAPI on :8012 (reached via the :8010 /pipecat proxy). Two transports:
  POST /api/daily/start  -> DailyTransport (production; LemonSlice's stack)
  POST /api/offer        -> SmallWebRTC (fallback when no DAILY_API_KEY)
Each call builds: mic in -> Gemini Live (voice loop) -> DittoVideoService -> out.
Single active session (the A100 runs one avatar pipeline at a time).
"""

import asyncio
import os
import sys
import time

import aiohttp
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipecat.frames.frames import LLMRunFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService, GeminiVADParams, InputParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

try:  # pipecat >= 0.0.100 layout, with legacy fallback
    from pipecat.transports.daily.transport import DailyParams, DailyTransport
except ImportError:  # pragma: no cover
    from pipecat.transports.services.daily import DailyParams, DailyTransport

from ditto_video_service import DittoVideoService, FramePacer, get_sdk
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

DAILY_API_KEY = os.environ.get("DAILY_API_KEY", "")
DAILY_API = "https://api.daily.co/v1"

AVATAR_DIR = os.path.expanduser("~/LiveTalking/data/avatars")
FOX_PROMPT = (
    "You are the CAR FOX — a sharp, upbeat fox mascot who helps people avoid "
    "buying bad used cars. Keep replies SHORT (one to three sentences), "
    "energetic, and conversational. Never mention being an AI."
)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_current: dict = {"task": None, "runner_task": None}


def _resolve_source(avatar_id: str):
    if "/" in avatar_id or ".." in avatar_id:
        return None
    for name in ("source.png", "source.jpg"):
        p = os.path.join(AVATAR_DIR, avatar_id, name)
        if os.path.exists(p):
            return p
    return None


async def _teardown_current():
    # single-session: cancel whatever is running and WAIT for it to fully
    # unwind before building the next pipeline (a second session built while
    # the first was mid-teardown never produced frames)
    if _current["task"] is not None:
        try:
            await _current["task"].cancel()
        except Exception:
            pass
        _current["task"] = None
    if _current.get("runner_task") is not None:
        try:
            await asyncio.wait_for(_current["runner_task"], timeout=10)
        except Exception:
            pass
        _current["runner_task"] = None
    # daily-python: the previous CallClient MUST be released or the next
    # session's camera track never transmits (first-call-works,
    # second-call-black in the same process)
    tr = _current.pop("transport", None)
    if tr is not None:
        try:
            raw = getattr(getattr(tr, "_client", None), "_client", None)
            if raw is not None:
                await asyncio.get_running_loop().run_in_executor(None, raw.release)
                logger.info("teardown: previous daily client released")
        except Exception as e:
            logger.warning(f"teardown: client release: {e}")



class _TestBars(FrameProcessor):
    """FOX_TEST_BARS=1 diagnostic: replaces the fox engine with moving color
    bars so pipeline-vs-engine faults separate cleanly."""

    def __init__(self):
        super().__init__()
        self._task = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        from pipecat.frames.frames import StartFrame
        if isinstance(frame, StartFrame) and self._task is None:
            self._task = asyncio.create_task(self._generate())

    async def _generate(self):
        import time as _t
        import numpy as _np
        from pipecat.frames.frames import OutputImageRawFrame
        i = 0
        base = _np.zeros((512, 512, 3), dtype=_np.uint8)
        deadline = _t.monotonic()
        while True:
            img = base.copy()
            x = (i * 7) % 512
            img[:, :, 0] = 40
            img[:, x : min(512, x + 60), 1] = 255
            await self.push_frame(
                OutputImageRawFrame(image=_np.ascontiguousarray(img).tobytes(), size=(512, 512), format="RGB")
            )
            i += 1
            deadline += 0.04
            d = deadline - _t.monotonic()
            if d > 0:
                await asyncio.sleep(d)
            else:
                deadline = _t.monotonic()



class _DropAudio(FrameProcessor):
    """FOX_TEST_BARS=3 diagnostic: discards downstream audio so the
    transport sees ditto's video cadence but none of its audio."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        from pipecat.frames.frames import TTSAudioRawFrame
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TTSAudioRawFrame):
            return
        await self.push_frame(frame, direction)


def _build_pipeline(transport, source: str):
    llm = GeminiLiveLLMService(
        api_key=os.environ["GEMINI_API_KEY"],
        # the exact model our browser voice loop conversed with for weeks
        model="models/gemini-3.1-flash-live-preview",
        voice_id="Puck",
        system_instruction=FOX_PROMPT,
        # reply reliability + snappier turns: trigger on quieter speech,
        # close the user's turn fast (this was the ~5s of the 13s reply lag)
        params=InputParams(vad=GeminiVADParams(
            start_sensitivity="START_SENSITIVITY_HIGH",
            end_sensitivity="END_SENSITIVITY_HIGH",
            silence_duration_ms=500,
        )),
    )

    ditto = None if os.environ.get("FOX_TEST_BARS") in ("1", "2") else DittoVideoService(source_path=source)  # mode 3 keeps ditto
    _current["ditto"] = ditto

    # Canonical shape from pipecat's official realtime Gemini example:
    # NO local VAD anywhere (server-side VAD handles turns), passive
    # context aggregators around the llm.
    context = LLMContext(
        [{"role": "developer", "content": "Greet me in one short energetic sentence and ask what kind of car I'm hunting for."}]
    )
    user_agg, assistant_agg = LLMContextAggregatorPair(context)

    test_mode = os.environ.get("FOX_TEST_BARS")
    if test_mode == "1":
        video_chain = [_TestBars()]
    elif test_mode == "2":  # pacer alone: static photo on the metronome
        video_chain = [FramePacer(fps=25, initial_image_path=source)]
    elif test_mode == "3":  # ditto runs, but its audio is discarded
        video_chain = [ditto, _DropAudio(), FramePacer(fps=25, initial_image_path=source)]
    else:
        pacer = FramePacer(fps=25, initial_image_path=source)
        _current["pacer"] = pacer
        video_chain = [ditto, pacer]
    pipeline = Pipeline([
        transport.input(),
        user_agg,
        llm,
        *video_chain,
        transport.output(),
        assistant_agg,
    ])
    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    _current["task"] = task

    async def send_greeting():
        if _current.get("greeted"):
            return
        _current["greeted"] = True
        # wait for the face engine — a greeting spoken over a frozen photo
        # reads as broken; lips must be able to move with the first word
        d = _current.get("ditto")
        for _ in range(40):
            if d is None or getattr(d, "_primed", False):
                break
            await asyncio.sleep(0.5)
        logger.info("pipecat: sending greeting (client can hear, engine primed)")
        await task.queue_frames([LLMRunFrame()])
        await asyncio.sleep(3)
        llm.set_audio_input_paused(False)
        logger.info("pipecat: audio input unpaused — conversational")

    _current["greet"] = send_greeting
    _current["greeted"] = False

    def arm_greet_fallback(delay: float = 25.0):
        async def greet_fallback():
            await asyncio.sleep(delay)
            await send_greeting()  # never leave a silent fox forever

        asyncio.create_task(greet_fallback())

    return task, arm_greet_fallback


async def _daily_post(session: aiohttp.ClientSession, path: str, payload: dict):
    async with session.post(
        f"{DAILY_API}{path}",
        headers={"Authorization": f"Bearer {DAILY_API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=aiohttp.ClientTimeout(total=15),
    ) as r:
        data = await r.json()
        if r.status >= 300:
            raise RuntimeError(f"daily {path} -> {r.status}: {data}")
        return data


@app.post("/api/daily/check")
async def daily_check(body: dict = None):
    return {"configured": bool(DAILY_API_KEY)}


@app.post("/api/daily/start")
async def daily_start(body: dict):
    """Create a Daily room + tokens, run the bot into it, hand the client its seat."""
    if not DAILY_API_KEY:
        return {"error": "daily_not_configured"}
    avatar_id = body.get("avatar_id", "fox_ditto")
    source = _resolve_source(avatar_id)
    if source is None:
        return {"error": f"unknown character avatar {avatar_id}"}

    await _teardown_current()

    exp = int(time.time()) + 3600
    async with aiohttp.ClientSession() as session:
        room = await _daily_post(session, "/rooms", {
            "privacy": "private",
            "properties": {
                "exp": exp,
                "max_participants": 2,
                "eject_at_room_exp": True,
                "enable_chat": False,
                "start_video_off": True,
                # stay on the SFU — the P2P switchover ~7s into a 2-person
                # room kills daily-python's outbound tracks (video 0bps)
                "sfu_switchover": 0.5,
            },
        })
        room_url = room["url"]
        room_name = room["name"]
        bot_token = (await _daily_post(session, "/meeting-tokens", {
            "properties": {"room_name": room_name, "is_owner": True, "user_name": "CAR FOX", "exp": exp},
        }))["token"]
        user_token = (await _daily_post(session, "/meeting-tokens", {
            "properties": {"room_name": room_name, "user_name": "driver", "exp": exp},
        }))["token"]

    transport = DailyTransport(
        room_url,
        bot_token,
        "CAR FOX",
        DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_sample_rate=16000,
            video_out_enabled=True,
            # NOT video_out_is_live: the non-live path redraws the newest
            # frame on the transport's own fixed 25fps clock, which is the
            # exact write pattern the bare daily-python probe proved out
            # (is_live mode produced 0 video bps through Daily's encoder)
            video_out_width=512,
            video_out_height=512,
            video_out_framerate=25,
        ),
    )

    _current["transport"] = transport
    task, arm_greet_fallback = _build_pipeline(transport, source)

    # Daily path: BOTH media tracks are written from plain threads, exactly
    # like the bare daily-python probe that streams perfectly — pipecat
    # handles signaling/mic-in/Gemini, the devices get direct writes.
    if _current.get("ditto") is not None:
        _current["ditto"].set_audio_sink_getter(
            lambda: getattr(getattr(transport._client, "_microphone_track", None), "source", None)
        )
    if _current.get("pacer") is not None:
        pacer = _current["pacer"]
        pacer._sink_getter = (
            lambda: getattr(getattr(transport._client, "_camera_track", None), "source", None)
        )
        if _current.get("ditto") is not None:
            # the audio writer publishes each 40ms tick's frame here —
            # lips follow the voice at playback time
            _current["ditto"]._frame_setter = (
                lambda fb, _p=pacer: setattr(_p, "_latest", (fb, (512, 512), "RGB"))
            )

    # write-path probe: does the pipeline still hand frames to daily-python
    # while the client sees 0 video bps?
    client = getattr(transport, "_client", None)
    if client is not None and hasattr(client, "write_video_frame"):
        orig_wvf = client.write_video_frame
        orig_waf = getattr(client, "write_audio_frame", None)

        async def counting_wvf(frame, _o=orig_wvf):
            n = _current["vw"] = _current.get("vw", 0) + 1
            if n % 100 == 1:
                logger.info(f"carfox-probe: video writes {n}")
            return await _o(frame)

        client.write_video_frame = counting_wvf
        if orig_waf is not None:
            async def counting_waf(frame, _o=orig_waf):
                n = _current["aw"] = _current.get("aw", 0) + 1
                if n % 100 == 1:
                    logger.info(f"carfox-probe: audio writes {n}")
                return await _o(frame)

            client.write_audio_frame = counting_waf

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(t, participant):
        logger.info("pipecat[daily]: participant joined — waiting for audible-playback confirmation")
        arm_greet_fallback(25)

    runner = PipelineRunner(handle_sigint=False)
    _current["runner_task"] = asyncio.create_task(runner.run(task))

    return {"room_url": room_url, "token": user_token, "expires": exp}


@app.post("/api/offer")
async def offer(body: dict):
    avatar_id = body.get("avatar_id", "fox_ditto")
    source = _resolve_source(avatar_id)
    if source is None:
        return {"error": f"unknown character avatar {avatar_id}"}

    await _teardown_current()

    connection = SmallWebRTCConnection(ice_servers=["stun:stun.l.google.com:19302"])
    await connection.initialize(sdp=body["sdp"], type=body["type"])

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_sample_rate=16000,
            video_out_enabled=True,
            video_out_is_live=True,
            video_out_width=512,
            video_out_height=512,
            video_out_framerate=25,
        ),
    )

    task, arm_greet_fallback = _build_pipeline(transport, source)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(t, client):
        logger.info("pipecat: client connected — waiting for audible-playback confirmation")
        arm_greet_fallback(25)

    runner = PipelineRunner(handle_sigint=False)
    _current["runner_task"] = asyncio.create_task(runner.run(task))

    answer = connection.get_answer()
    return answer


@app.post("/api/telemetry")
async def telemetry(body: dict):
    """Client-side ground truth lands in our logs (audibility, fps, play state)."""
    logger.info(f"carfox-telemetry: {body}")
    if body.get("event") in ("play_ok", "unmute_ok") and _current.get("greet"):
        await _current["greet"]()
    return {"ok": True}


@app.get("/health")
async def health():
    return {"ok": True, "active": _current.get("task") is not None}


if __name__ == "__main__":
    get_sdk()  # preload models before accepting calls
    uvicorn.run(app, host="0.0.0.0", port=8012)
