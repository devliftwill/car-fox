# Car Fox live-avatar daemon — always-on host (Railway / Render / Fly).
# Keeps pipecat + Gemini Live warm; starts/stops LemonSlice sessions on demand.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps: some pipecat/daily transitive wheels want a C toolchain + ffmpeg libs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY fox_daemon.py ./

# The platform injects $PORT; the daemon reads it and binds 0.0.0.0 when PORT is set.
EXPOSE 7788
CMD ["python", "fox_daemon.py"]
