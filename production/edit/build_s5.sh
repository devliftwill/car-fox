#!/bin/bash
# Rebuild the report insert + cut it into S5.
# Usage: ./build_s5.sh <raw-s5-clip>   (default clips/archive-s5-v3-raw.mp4)
# Insert covers S5 video 0-3.2s; original S5 audio runs unbroken (sync preserved).
set -euo pipefail
cd "$(dirname "$0")/.."
RAW="${1:-clips/archive-s5-v3-raw.mp4}"

# 1) insert plate: prefer the paw-held composite (report/insert-plate-paw.png,
#    built by report/paw_composite.py) over the flat phone mockup
PLATE=report/insert-plate.png
if [[ -f report/insert-plate-paw.png ]]; then
  PLATE=report/insert-plate-paw.png
fi
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
( cd report && "$CHROME" --headless --disable-gpu --screenshot=report-screen.png \
    --window-size=390,844 --force-device-scale-factor=3 --hide-scrollbars \
    "file://$PWD/carfox-report.html" 2>/dev/null )
( cd report && python3 - <<'EOF'
from PIL import Image, ImageDraw, ImageFilter
screen = Image.open('report-screen.png').convert('RGB')
SW, SH = screen.size
BEZ = 36; PW, PH = SW + BEZ*2, SH + BEZ*2; CORNER = 190
phone = Image.new('RGBA', (PW, PH), (0,0,0,0))
d = ImageDraw.Draw(phone)
d.rounded_rectangle([0,0,PW-1,PH-1], CORNER, fill=(18,20,24,255))
d.rounded_rectangle([6,6,PW-7,PH-7], CORNER-6, outline=(70,74,82,255), width=3)
mask = Image.new('L', (SW,SH), 0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,SW-1,SH-1], CORNER-BEZ, fill=255)
phone.paste(screen, (BEZ,BEZ), mask)
ImageDraw.Draw(phone).rounded_rectangle([PW//2-160, BEZ+14, PW//2+160, BEZ+66], 26, fill=(18,20,24,255))
bg = Image.open('/private/tmp/claude-501/-Users-will-Repos-car-fox/9ce4847a-8de9-42a7-a360-a8ad392cfe5b/scratchpad/civic.png')
bg = bg.convert('RGB').resize((3840,2160), Image.LANCZOS)
bg = bg.filter(ImageFilter.GaussianBlur(30)).point(lambda p: int(p*0.62))
ph_h = 1980; ph_w = round(PW*ph_h/PH)
phone_s = phone.resize((ph_w, ph_h), Image.LANCZOS)
x0, y0 = (3840-ph_w)//2, (2160-ph_h)//2
sh = Image.new('RGBA', (3840,2160), (0,0,0,0))
ImageDraw.Draw(sh).rounded_rectangle([x0+18, y0+34, x0+ph_w+18, y0+ph_h+34], 160, fill=(0,0,0,160))
sh = sh.filter(ImageFilter.GaussianBlur(40))
canvas = bg.convert('RGBA'); canvas.alpha_composite(sh); canvas.alpha_composite(phone_s, (x0,y0))
canvas.convert('RGB').save('insert-plate.png')
EOF
)
ffmpeg -y -v error -loop 1 -i "$PLATE" -t 3.2 \
  -filter_complex "[0:v]scale=3840:2160,zoompan=z='1.30+0.07*on/77':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2 - 30*on/77':d=1:s=1920x1080:fps=24[v]" \
  -map "[v]" -c:v libx264 -crf 18 -pix_fmt yuv420p report/report-insert.mp4

# 2) splice: insert video 0-3.2, raw video 3.2-8.0.
#    Audio 0-3.2 is REBUILT (raw dialogue there is garbled mumble): clean suburb
#    ambience looped from S1 + the friend's scripted line reading the report.
#    Raw audio resumes untouched at 3.2 so the handshake stays in sync.
# Audio J-cut: rebuilt bed runs 0-2.95, raw resumes at 2.95 — just before the
# buyer's "Thanks, Car Fox" (starts 2.99 in the raw) so the line plays WHOLE,
# leading the video cut at 3.2 like a natural J-cut.
ffmpeg -y -v error -i "$RAW" -i report/report-insert.mp4 \
  -i clips/s1-almost.mp4 -i vo/buyerline.wav -filter_complex "\
[1:v]trim=0:3.2,setpts=PTS-STARTPTS[a];\
[0:v]trim=3.2:8.0,setpts=PTS-STARTPTS[b];\
[a][b]concat=n=2:v=1:a=0,fps=24[v];\
[2:a]atrim=0:1.6,asetpts=PTS-STARTPTS,aloop=loop=1:size=76800,asetpts=N/SR/TB,\
aformat=sample_rates=48000:channel_layouts=stereo,volume=0.9[amb];\
[3:a]adelay=700|700,aformat=sample_rates=48000:channel_layouts=stereo[line];\
[amb][line]amix=inputs=2:normalize=0,atrim=0:2.95,asetpts=PTS-STARTPTS[ins];\
[0:a]atrim=2.95:8.0,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[tail];\
[ins][tail]concat=n=2:v=0:a=1[aud]" \
  -map "[v]" -map "[aud]" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac clips/s5-handshake.mp4
echo "s5 rebuilt from $RAW"
