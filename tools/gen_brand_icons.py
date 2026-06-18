"""North Star brand icon generator.

Draws the house compass-star (gold north-star + compass-rose dotted ring)
on the brand palette, and emits every asset the mobile app + desktop agent
need. One source of truth so the marks stay identical across surfaces.

Palette: navy #0f1d3a, cream #f3ecdb, warm gold #c19a3e.
Run: python tools/gen_brand_icons.py <out_dir>
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersample factor for antialiasing

NAVY = (15, 29, 58)
NAVY_HI = (28, 45, 84)
NAVY_LO = (8, 16, 34)
CREAM = (243, 236, 219)
CREAM_LO = (228, 216, 190)
GOLD = (196, 156, 62)
GOLD_HI = (228, 198, 112)
GOLD_LO = (150, 116, 44)


def _radial_bg(size, inner, outer):
    """Vertical-ish radial vignette from `inner` (center) to `outer` (corner)."""
    img = Image.new("RGB", (size, size), outer)
    px = img.load()
    cx = cy = size / 2
    maxd = math.hypot(cx, cy)
    for y in range(size):
        for x in range(size):
            t = math.hypot(x - cx, y - cy) / maxd
            t = min(1.0, t)
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(3))
    return img


def _star_polygon(cx, cy, r_out, r_in, up=1.0, down=1.0, side=1.0, rot=0.0):
    pts = []
    outer = [up, side, down, side]  # N, E, S, W
    for i in range(4):
        a = math.radians(-90 + i * 90) + rot
        ro = r_out * outer[i]
        pts.append((cx + ro * math.cos(a), cy + ro * math.sin(a)))
        a2 = math.radians(-90 + i * 90 + 45) + rot
        pts.append((cx + r_in * math.cos(a2), cy + r_in * math.sin(a2)))
    return pts


def _vgrad(size, top, bottom):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = c
    return g


def draw_mark(size, bg="navy", with_ring=True, glow=True):
    """The full mark on a background. bg in {navy, cream, transparent}."""
    S = size * SS
    if bg == "navy":
        base = _radial_bg(S, NAVY_HI, NAVY_LO).convert("RGBA")
    elif bg == "cream":
        base = _radial_bg(S, CREAM, CREAM_LO).convert("RGBA")
    else:
        base = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    cx = cy = S / 2
    R = S * 0.30
    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    ring_col = GOLD if bg != "cream" else GOLD_LO
    # Soft gold glow behind the star (premium halo).
    if glow:
        gl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        gd = ImageDraw.Draw(gl)
        gr = R * 1.15
        gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=GOLD_HI + (70,))
        gl = gl.filter(ImageFilter.GaussianBlur(R * 0.28))
        base = Image.alpha_composite(base, gl)

    # Compass-rose dotted ring + hairline ring.
    if with_ring:
        rr = R * 1.16
        ndots = 48
        dot = max(1, int(S * 0.006))
        for i in range(ndots):
            a = math.radians(i * 360 / ndots)
            x = cx + rr * math.cos(a)
            y = cy + rr * math.sin(a)
            big = (i % 4 == 0)
            rad = dot * (1.7 if big else 1.0)
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=ring_col + (255 if big else 170,))
        hair = R * 1.30
        d.ellipse([cx - hair, cy - hair, cx + hair, cy + hair], outline=ring_col + (150,), width=max(1, int(S * 0.004)))

    # Short diagonal points (lighter gold), behind the main star.
    short = _star_polygon(cx, cy, R * 0.46, R * 0.12, rot=math.radians(45))
    d.polygon(short, fill=GOLD_HI + (235,))

    # Main 4-point north star with a vertical gradient fill.
    main = _star_polygon(cx, cy, R, R * 0.15, up=1.0, down=0.96, side=0.72)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(main, fill=255)
    grad = _vgrad(S, GOLD_HI, GOLD_LO).convert("RGBA")
    overlay = Image.alpha_composite(overlay, Image.composite(grad, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
    # thin center sparkle
    cr = R * 0.05
    ImageDraw.Draw(overlay).ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=CREAM + (255,))

    out = Image.alpha_composite(base, overlay)
    return out.resize((size, size), Image.LANCZOS)


def draw_mono(size):
    """White star silhouette on transparent (Android themed icon)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = S / 2
    R = S * 0.30
    d.polygon(_star_polygon(cx, cy, R * 0.46, R * 0.12, rot=math.radians(45)), fill=(255, 255, 255, 230))
    d.polygon(_star_polygon(cx, cy, R, R * 0.15, up=1.0, down=0.96, side=0.72), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def _scaled(size, frac, bg="transparent"):
    """A mark shrunk to `frac` of the canvas, centred on transparent."""
    inner = draw_mark(int(size * frac), bg)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - inner.width) // 2
    canvas.paste(inner, (off, off), inner)
    return canvas


def emit_mobile(images_dir):
    import os
    os.makedirs(images_dir, exist_ok=True)
    draw_mark(1024, "navy").save(f"{images_dir}/icon.png")
    draw_mark(1024, "transparent").save(f"{images_dir}/splash-icon.png")
    # Adaptive: star within the safe zone, navy background plate.
    _scaled(1024, 0.80, "transparent").save(f"{images_dir}/android-icon-foreground.png")
    _radial_bg(1024, NAVY_HI, NAVY_LO).save(f"{images_dir}/android-icon-background.png")
    draw_mono(1024).save(f"{images_dir}/android-icon-monochrome.png")
    draw_mark(196, "navy").save(f"{images_dir}/favicon.png")
    print("wrote mobile assets to", images_dir)


def emit_agent(assets_dir):
    import os
    os.makedirs(assets_dir, exist_ok=True)
    for size in (64, 256):
        img = draw_mark(size, "navy").convert("RGBA")
        with open(f"{assets_dir}/brand-{size}.rgba", "wb") as f:
            f.write(img.tobytes("raw", "RGBA"))
        img.save(f"{assets_dir}/brand-{size}.png")  # for reference/preview
    print("wrote agent rgba to", assets_dir)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "preview"
    if mode == "emit":
        emit_mobile(sys.argv[2])
        emit_agent(sys.argv[3])
    else:
        out = sys.argv[1] if len(sys.argv) > 1 else "."
        import os
        os.makedirs(out, exist_ok=True)
        draw_mark(512, "navy").save(f"{out}/preview_navy.png")
        draw_mark(512, "cream").save(f"{out}/preview_cream.png")
        print("wrote previews to", out)


if __name__ == "__main__":
    main()
