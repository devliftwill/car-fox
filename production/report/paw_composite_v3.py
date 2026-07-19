#!/usr/bin/env python3
"""Replace nano's phone with a code-built phone unit (screen+bezel rigid),
rotated/scaled into the paw scene; fingers erased from their original spot,
shifted right to grip the new bezel, thumb repainted on top.
Alignment is correct by construction. Tune placement constants and re-run.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BASE = Image.open('paw-phone-v2.png').convert('RGB')
SHOT = Image.open('report-screen-wide.png').convert('RGB')     # 1428x2532

CENTER = (1350, 744)      # phone placement center in scene
ANGLE = 6.74              # degrees CCW (phone top leans left)
GLASS_H = 1249            # px along phone axis in scene
SCALE_PAD = 1.162         # sized so both bezel edges reach the grip
FINGER_SHIFT = 0          # fingers stay put; phone reaches them

FINGER_BOX = (700, 700, 992, 1380)
THUMB_BOX = (1330, 950, 1860, 1500)


def build_phone():
    BEZ, CR = 42, 200
    W, H = SHOT.width + BEZ*2, SHOT.height + BEZ*2
    ph = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ph)
    d.rounded_rectangle([0, 0, W-1, H-1], CR, fill=(16, 18, 22, 255))
    d.rounded_rectangle([4, 4, W-5, H-5], CR-4, outline=(96, 100, 108, 255), width=5)
    d.rounded_rectangle([10, 10, W-11, H-11], CR-9, outline=(50, 52, 58, 255), width=3)
    mask = Image.new('L', SHOT.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SHOT.width-1, SHOT.height-1], CR-BEZ, fill=255)
    warm = Image.new('RGB', SHOT.size, (255, 236, 210))
    shot = Image.blend(SHOT, warm, 0.05).point(lambda p: int(p * 0.985))
    ph.paste(shot, (BEZ, BEZ), mask)
    d = ImageDraw.Draw(ph)
    d.rounded_rectangle([W//2 - 150, BEZ + 16, W//2 + 150, BEZ + 72], 28, fill=(16, 18, 22, 255))
    return ph


def fur_mask(box, rg=14):
    arr = np.asarray(BASE, dtype=np.int16)
    r, g, b = arr[...,0], arr[...,1], arr[...,2]
    fur = (r > 82) & (r > g + rg) & (g > b - 8) & (r > b + 14) & ((r - g) < 135) & (g > 42)
    boxm = np.zeros(fur.shape, dtype=bool)
    x0, y0, x1, y1 = box
    boxm[y0:y1, x0:x1] = True
    m = Image.fromarray(((fur & boxm) * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.MinFilter(9))
    solid = m.point(lambda p: 255 if p > 127 else 0)
    ImageDraw.floodfill(solid, (0, 0), 128)
    a = np.asarray(solid)
    m = Image.fromarray(np.where(a == 128, 0, 255).astype(np.uint8))
    return m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))


def main():
    fmask = fur_mask(FINGER_BOX)
    tmask = fur_mask(THUMB_BOX, rg=32)

    # nano's old bottom-bezel line rides through the fur masks as a warm
    # metallic strip — erase a band along its known geometry (old BL->BR)
    eraser = Image.new('L', BASE.size, 0)
    ed = ImageDraw.Draw(eraser)
    ed.line([(1290, 1428), (1800, 1336)], fill=255, width=84)
    ed.rectangle([1795, 0, BASE.width, BASE.height], fill=0)  # keep palm fur
    earr = np.asarray(eraser) > 0
    fmask = Image.fromarray(np.where(earr, 0, np.asarray(fmask)).astype(np.uint8))
    tmask = Image.fromarray(np.where(earr, 0, np.asarray(tmask)).astype(np.uint8))

    out = BASE.copy()

    # phone with drop shadow
    ph = build_phone()
    scale = (GLASS_H / SHOT.height) * SCALE_PAD
    ph = ph.resize((round(ph.width * scale), round(ph.height * scale)), Image.LANCZOS)
    ph = ph.rotate(ANGLE, expand=True, resample=Image.BICUBIC)
    sh = Image.new('L', BASE.size, 0)
    shp = ph.split()[3].point(lambda p: 110 if p > 60 else 0)
    sh.paste(shp, (CENTER[0] - ph.width//2 + 14, CENTER[1] - ph.height//2 + 22))
    sh = sh.filter(ImageFilter.GaussianBlur(30))
    out.paste(Image.new('RGB', BASE.size, (25, 22, 20)), (0, 0), sh)
    out.paste(ph, (CENTER[0] - ph.width//2, CENTER[1] - ph.height//2), ph)

    # 3) thumb contact shadow, then fingers shifted onto the bezel, then thumb
    ts = Image.new('L', BASE.size, 0)
    ImageDraw.Draw(ts).ellipse([1360, 1120, 1700, 1330], fill=80)
    ts = ts.filter(ImageFilter.GaussianBlur(26))
    out.paste(Image.new('RGB', BASE.size, (20, 24, 30)), (0, 0), ts)

    # finger contact shadow just right of the tips — only ON the phone body
    fs = np.asarray(fmask)
    fshadow = Image.fromarray(np.roll(fs, 14, axis=1)).point(lambda p: min(p, 60))
    fshadow = fshadow.filter(ImageFilter.GaussianBlur(9))
    phone_region = Image.new('L', BASE.size, 0)
    phone_region.paste(ph.split()[3].point(lambda p: 255 if p > 40 else 0),
                       (CENTER[0] - ph.width//2, CENTER[1] - ph.height//2))
    fshadow = Image.fromarray(np.minimum(np.asarray(fshadow), np.asarray(phone_region)))
    out.paste(Image.new('RGB', BASE.size, (20, 18, 16)), (0, 0), fshadow)

    out.paste(BASE, (0, 0), fmask)
    out.paste(BASE, (0, 0), tmask)

    out.save('insert-plate-paw.png')
    print('wrote insert-plate-paw.png', out.size)


if __name__ == '__main__':
    main()
