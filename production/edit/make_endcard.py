#!/usr/bin/env python3
"""End card for CAR FOX 'SOMEBODY KNOWS' — real typography, no AI text.

Layout: cobalt field (sampled from the character art), headline left,
full-body fox cutout right. Outputs 1920x1080 PNG.
Usage: python3 make_endcard.py [fox_cutout.png]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"

W, H = 1920, 1080
TOP_BLUE = (21, 114, 204)      # sampled from carfox-avatar.png top
BOTTOM_BLUE = (10, 90, 175)    # slightly deeper to ground the frame

def gradient(w, h, top, bottom):
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        t = y / (h - 1)
        px_row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = px_row
    return im


def main():
    fox_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ASSETS / "fox-cutout.png"
    card = gradient(W, H, TOP_BLUE, BOTTOM_BLUE)

    # Fox on the right third, feet at a consistent floor line
    fox = Image.open(fox_path).convert("RGBA")
    fox_h = 940
    fox_w = round(fox.width * fox_h / fox.height)
    fox = fox.resize((fox_w, fox_h), Image.LANCZOS)
    card.paste(fox, (W - fox_w - 140, H - fox_h - 40), fox)

    draw = ImageDraw.Draw(card)
    head = ImageFont.truetype(str(ASSETS / "inter-700.ttf"), 118)
    sub = ImageFont.truetype(str(ASSETS / "inter-400.ttf"), 46)

    x = 150
    draw.text((x, 360), "KNOW BEFORE", font=head, fill="white")
    draw.text((x, 490), "YOU BUY.", font=head, fill="white")
    draw.text((x, 660), "Get the CAR FOX report.", font=sub, fill=(210, 230, 250))

    out = HERE.parent / "endcard-16x9.png"
    card.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
