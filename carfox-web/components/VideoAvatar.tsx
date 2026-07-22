"use client";

/**
 * VideoAvatar — the "living portrait": a looping idle clip as the base layer
 * (real motion, real blinks, real texture — the aliveness comes from actual
 * footage, like HeyGen builds avatars from recorded video), with the viseme
 * mouth composited each frame at the PRE-TRACKED face position (lib/videoRig
 * analyzed the clip once at rig time — zero runtime ML).
 *
 * Same `sample()` driver as FoxAvatar/PhotoAvatar.
 */
import { useEffect, useRef } from "react";
import type { FoxSample } from "./FoxAvatar";
import { drawMouthComposite } from "@/lib/mouthComposite";
import { rigAt } from "@/lib/videoRig";
import type { AvatarConfig } from "@/lib/avatarStore";

export default function VideoAvatar({
  config,
  sample,
  className,
  debugTag,
}: {
  config: AvatarConfig; // mode "video": needs config.video (track) + config.videoUrl
  sample?: () => FoxSample;
  className?: string;
  debugTag?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef(sample);
  useEffect(() => {
    sampleRef.current = sample;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const cfg = config;
    const track = cfg.video;
    if (!canvas || !track || !cfg.videoUrl) return;
    const W = cfg.w, H = cfg.h;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const video = document.createElement("video");
    video.src = cfg.videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let ready = false;
    video.oncanplay = () => {
      ready = true;
      video.play().catch(() => {});
    };
    video.load();

    let raf = 0;
    let lastTick = 0;
    const mouth = { open: 0, round: 0 };

    const tick = () => {
      lastTick = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (!ready) return;

      // manual loop over the ANALYZED window (upload may be longer)
      if (video.currentTime >= track.duration - 0.06) {
        video.currentTime = 0;
        if (video.paused) video.play().catch(() => {});
      }

      const s: FoxSample = sampleRef.current?.() ?? { mouth: null };
      const m = s.mouth;
      mouth.open += ((m ? m.open : 0) - mouth.open) * 0.5;
      mouth.round += ((m ? m.round : mouth.round * 0.9) - mouth.round) * 0.35;

      ctx.drawImage(video, 0, 0, W, H);

      const rig = rigAt(track, video.currentTime);
      const dbg: Record<string, unknown> = debugTag
        ? { open: mouth.open, t: video.currentTime, mouthX: rig.mouth.x, drew: "none" }
        : {};
      drawMouthComposite(ctx, video, W, H, rig, mouth.open, mouth.round, debugTag ? dbg : undefined);
      if (debugTag) {
        const w = window as unknown as { __paDbg?: Record<string, unknown> };
        w.__paDbg = w.__paDbg || {};
        w.__paDbg[debugTag] = dbg;
      }
    };

    raf = requestAnimationFrame(tick);
    const watchdog = setInterval(() => {
      if (performance.now() - lastTick > 350) tick();
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      video.pause();
      video.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remounts via key upstream; debugTag is a dev constant
  }, []);

  return <canvas ref={canvasRef} className={className} aria-label="Living portrait avatar" role="img" />;
}
