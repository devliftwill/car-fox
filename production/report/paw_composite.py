#!/usr/bin/env python3
"""Composite the real report screenshot onto the nano paw-phone plate.

Perspective-warps report-screen.png onto the phone's screen quad, then
repaints the thumb by color-segmenting its fur silhouette inside THUMB_BOX
(no ellipse guessing), and adds a soft contact shadow along its underside.
Tune QUAD / THUMB_BOX and re-run.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BASE = Image.open('paw-phone-v2.png').convert('RGB')           # 2752x1536 nano plate
SHOT = Image.open('report-screen.png').convert('RGB')          # 1170x2532 real UI

# Screen glass corners in BASE pixel coords: TL, TR, BR, BL
QUAD = [(894, 126), (1600, 90), (1736, 1308), (1051, 1389)]

# Bounding box that contains the thumb where it overlaps the glass
THUMB_BOX = (1330, 990, 1830, 1470)


def perspective_coeffs(src_pts, dst_pts):
    """Coefficients mapping dst -> src for Image.transform(PERSPECTIVE)."""
    a = []
    for (sx, sy), (dx, dy) in zip(src_pts, dst_pts):
        a.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        a.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    A = np.array(a, dtype=float)
    b = np.array([c for pt in src_pts for c in pt], dtype=float)
    return np.linalg.solve(A, b)


def thumb_mask():
    """Fur-colored pixels inside THUMB_BOX, dilated and feathered."""
    arr = np.asarray(BASE, dtype=np.int16)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    fur = (r > 82) & (r > g + 14) & (g > b - 8) & (r > b + 14)
    box = np.zeros(fur.shape, dtype=bool)
    x0, y0, x1, y1 = THUMB_BOX
    box[y0:y1, x0:x1] = True
    mask = Image.fromarray(((fur & box) * 255).astype(np.uint8))
    # close + fill interior holes (pale highlight fur fails the color test)
    mask = mask.filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.MinFilter(9))
    solid = mask.point(lambda p: 255 if p > 127 else 0)
    ImageDraw.floodfill(solid, (0, 0), 128)
    arr2 = np.asarray(solid)
    filled = np.where(arr2 == 128, 0, 255).astype(np.uint8)
    mask = Image.fromarray(filled)
    mask = mask.filter(ImageFilter.MaxFilter(5))
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    return mask


def main():
    m = Image.new('L', SHOT.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, SHOT.width - 1, SHOT.height - 1], 110, fill=255)

    src_rect = [(0, 0), (SHOT.width, 0), (SHOT.width, SHOT.height), (0, SHOT.height)]
    coeffs = perspective_coeffs(src_rect, QUAD)
    warped = SHOT.transform(BASE.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    warped_mask = m.transform(BASE.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    out = BASE.copy()
    warm = Image.new('RGB', BASE.size, (255, 236, 210))
    warped = Image.blend(warped, warm, 0.05)
    warped = warped.point(lambda p: int(p * 0.985))
    out.paste(warped, (0, 0), warped_mask)

    # soft contact shadow along the thumb's underside, on the fresh screen
    sh = Image.new('L', BASE.size, 0)
    ImageDraw.Draw(sh).ellipse([1360, 1120, 1700, 1330], fill=80)
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    black = Image.new('RGB', BASE.size, (20, 24, 30))
    out.paste(black, (0, 0), sh)

    # thumb silhouette repainted on top of screen + shadow
    out.paste(BASE, (0, 0), thumb_mask())

    # clip content to the TRUE glass arc: in a ring around the quad edges,
    # repaint every dark (bezel) pixel of the original plate over the content
    base_arr = np.asarray(BASE, dtype=np.int16)
    blum = 0.299*base_arr[...,0] + 0.587*base_arr[...,1] + 0.114*base_arr[...,2]
    ring = Image.new('L', BASE.size, 0)
    rd = ImageDraw.Draw(ring)
    cxq = sum(p[0] for p in QUAD) / 4.0
    cyq = sum(p[1] for p in QUAD) / 4.0
    def scaled(f):
        return [(cxq + (x - cxq) * f, cyq + (y - cyq) * f) for x, y in QUAD]
    rd.polygon(scaled(1.25), fill=255)   # outer band
    rd.polygon(scaled(0.972), fill=0)    # keep 18px-ish inner margin only
    ring_arr = np.asarray(ring) > 0
    bezel = (blum < 75) & ring_arr
    bm = Image.fromarray((bezel * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    out.paste(BASE, (0, 0), bm)

    out.save('insert-plate-paw.png')
    print('wrote insert-plate-paw.png', out.size)


if __name__ == '__main__':
    main()
