#!/bin/bash
# CAR FOX "SOMEBODY KNOWS" — full finish (NEPHEW pipeline pattern).
# Needs: clips/s1-almost.mp4 s2-sense.mp4 s3-run.mp4 s4-save.mp4 s5-handshake.mp4
#        endcard-16x9.png  score.wav  vo/line1.wav vo/line2.wav vo/line3.wav
# Timeline: S1 0-6 | S2 6-12 | S3 12-20 | S4 20-28 | S5 28-36 | card 36-40
set -euo pipefail
cd "$(dirname "$0")/.."

CLIPS=(clips/s1-almost.mp4 clips/s2-sense.mp4 clips/s3-run.mp4 clips/s4-save.mp4 clips/s5-handshake.mp4)
DURS=(6 6 8 8 8)
for c in "${CLIPS[@]}"; do [[ -f $c ]] || { echo "missing $c"; exit 1; }; done

# 4s end card (silent) — animated fox + real type overlay when endcard-anim.mp4 exists
if [[ -f endcard-anim.mp4 ]]; then
  ffmpeg -y -v error -i endcard-anim.mp4 -loop 1 -i endcard-type.png -f lavfi -i anullsrc=r=48000:cl=stereo \
    -filter_complex "[1:v]format=rgba,fade=in:st=0.3:d=0.6:alpha=1[t];[0:v][t]overlay=0:0:shortest=1,scale=1920:1080[v]" \
    -map "[v]" -map 2:a -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clips/s6-endcard.mp4
else
  ffmpeg -y -v error -loop 1 -i endcard-16x9.png -f lavfi -i anullsrc=r=48000:cl=stereo \
    -t 4 -c:v libx264 -pix_fmt yuv420p -vf scale=1920:1080 -c:a aac -shortest clips/s6-endcard.mp4
fi

# Conform each clip to exact length / fps / res so the timeline is frame-accurate
i=0; inputs=(); filters=""
for c in "${CLIPS[@]}"; do
  inputs+=(-i "$c")
  filters+="[$i:v]trim=duration=${DURS[$i]},scale=1920:1080,fps=24,setsar=1,setpts=PTS-STARTPTS[v$i];"
  filters+="[$i:a]atrim=duration=${DURS[$i]},aresample=48000,asetpts=PTS-STARTPTS[a$i];"
  i=$((i+1))
done
inputs+=(-i clips/s6-endcard.mp4)
filters+="[$i:v]scale=1920:1080,fps=24,setsar=1,setpts=PTS-STARTPTS[v$i];[$i:a]aresample=48000,asetpts=PTS-STARTPTS[a$i];"
n=$((i+1)); concat=""
for k in $(seq 0 $i); do concat+="[v$k][a$k]"; done

# Picture + native audio concat
ffmpeg -y -v error "${inputs[@]}" \
  -filter_complex "${filters}${concat}concat=n=$n:v=1:a=1[v][nat]" \
  -map "[v]" -map "[nat]" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac picture-lock.mp4

# Mix: native SFX bed + score + three VO lines at timeline offsets
VOICE="${VOICE:-sarah}"   # sarah | lily | oraclex | google | kore | "" (empty = Declan Sage)
P="${VOICE:+$VOICE-}"
# End-card line starts so it finishes 0.25s before the 40s tail, but never before 34.5s
L3=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "vo/${P}line3.wav")
D3=$(python3 -c "print(max(34500, int((40.0 - $L3 - 0.25) * 1000)))")
ffmpeg -y -v error -i picture-lock.mp4 -i score.wav \
  -i "vo/${P}line1.wav" -i "vo/${P}line2.wav" -i "vo/${P}line3.wav" \
  -filter_complex "\
[1:a]volume=0.60[mus];\
[2:a]adelay=800|800,volume=1.0[v1];\
[3:a]adelay=10600|10600,volume=1.0[v2];\
[4:a]adelay=${D3}|${D3},volume=1.0[v3];\
[0:a]volume=0.75[nat];\
[nat][mus][v1][v2][v3]amix=inputs=5:normalize=0,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 256k somebody-knows-master-16x9.mp4

# 4:5 feed version (letterboxed, NEPHEW deliverable pattern)
ffmpeg -y -v error -i somebody-knows-master-16x9.mp4 \
  -vf "scale=1080:-2,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=black" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy somebody-knows-master-4x5.mp4

echo "done: somebody-knows-master-16x9.mp4 / somebody-knows-master-4x5.mp4"
