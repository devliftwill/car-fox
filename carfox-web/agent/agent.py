"""
Car Fox — self-managed pipeline: Gemini Live (brain + voice) x LemonSlice (face).

This is the Seny-compatible architecture:
  browser <-> LiveKit room
     brain/voice: Gemini Live realtime (gemini-3.1-flash-live-preview — same model as Seny)
     face:        LemonSlice avatar plugin (lip-syncs whatever audio the session produces)

Run:
  uv venv && uv pip install -r requirements.txt
  python agent.py dev

Required env (put in ../.env.local or export):
  LEMONSLICE_API_KEY   (set)
  GEMINI_API_KEY       (set — copied from Seny)
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET  (TODO: free account at cloud.livekit.io)
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentSession, Agent, RoomInputOptions
from livekit.plugins import google, lemonslice, noise_cancellation

load_dotenv(Path(__file__).resolve().parents[1] / ".env.local")

# The Car Fox image — same render the site uses. Must be a public URL in production;
# for local dev, LemonSlice fetches it, so use the deployed site URL or any public copy.
AGENT_IMAGE_URL = os.environ.get(
    "CARFOX_IMAGE_URL",
    "https://play-lh.googleusercontent.com/0Qs57BBcxidJ8g3K3UD4ZvYZ1VFHxUGYX_m08UpaJXpnTIIO65ZmvX4-MjOedphk5120_NUVKQw8kniMl9j8HMU",
)

SYSTEM_PROMPT = """You are the Car Fox, a quick-witted, upbeat cartoon fox mascot for a
curated performance-car lot. Keep replies short and punchy (1-2 sentences), warm and
playful, with the occasional fox pun. Never break character.
Inventory (real vehicles, real CARFAX-listed history — answer only from this data):
1) 2023 BMW M5 — $83,995, 30,158 mi, VIN WBS83CH00PCM91400, no accidents, 1 owner, Newport Beach.
2) 2024 BMW M4 Competition — $70,237, 27,575 mi, VIN WBS33AZ05RCP65741, no accidents, 1 owner, Van Nuys.
3) 2023 Mercedes-AMG GT 63 — $116,900, 8,544 mi, VIN W1K7X8JB0PA063246, no accidents, 1 owner, Newport Beach.
4) 2026 Porsche Panamera GTS — $184,888, 2,998 mi, VIN WP0AG2YA6TL070517, certified, Pasadena.
5) 2018 Chevrolet Camaro SS 1SS — $29,585, 75,217 mi, VIN 1G1FF1R75J0189690, MINOR DAMAGE reported,
   3+ owners — always disclose honestly. North Hollywood.
6) 2015 Ford Mustang GT — $18,988, 93,055 mi, VIN 1FA6P8CF6F5370519, no accidents, 3+ owners, manual. Bell, CA.
"""


async def entrypoint(ctx: agents.JobContext):
    session = AgentSession(
        # Gemini Live: realtime speech-to-speech — brain AND voice in one.
        llm=google.beta.realtime.RealtimeModel(
            model="gemini-3.1-flash-live-preview",
            voice="Puck",  # Google's playful voice — closest to a fox
            api_key=os.environ["GEMINI_API_KEY"],
        ),
    )

    avatar = lemonslice.AvatarSession(
        agent_image_url=AGENT_IMAGE_URL,
        agent_prompt="A friendly cartoon fox mascot talking, expressive, upbeat.",
        api_key=os.environ["LEMONSLICE_API_KEY"],
    )
    await avatar.start(session, room=ctx.room)

    await session.start(
        room=ctx.room,
        agent=Agent(instructions=SYSTEM_PROMPT),
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
        ),
    )


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
