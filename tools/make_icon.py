"""Render the Patchwork app icon (lucide 'cable' style) to a PNG."""

from pathlib import Path
from PIL import Image, ImageDraw

OUT   = Path(__file__).parent.parent / "resources" / "patchwork-icon.png"
FINAL = 512
SCALE = 4
SIZE  = FINAL * SCALE

BG_DARK = (22, 24, 28, 255)
BG_EDGE = (37, 40, 46, 255)
ORANGE  = (255, 170, 51, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d   = ImageDraw.Draw(img)

# Background: rounded square panel with subtle border
R = int(SIZE * 0.22)
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=R, fill=BG_DARK, outline=BG_EDGE, width=3 * SCALE)

# Lucide uses a 24×24 viewBox. Map it into a centred 70% drawing area.
DRAW = int(SIZE * 0.70)
OFF  = (SIZE - DRAW) // 2
def x(v): return OFF + v * DRAW / 24
def y(v): return OFF + v * DRAW / 24

stroke = max(3, int(DRAW * 0.075))

def line(p):
    d.line(p, fill=ORANGE, width=stroke, joint="curve")

def round_rect(box):
    d.rounded_rectangle(box, radius=stroke * 0.6, outline=ORANGE, width=stroke)

def arc(box, start, end):
    # PIL's arc() draws with width but no joint, so it's fine standalone.
    d.arc(box, start=start, end=end, fill=ORANGE, width=stroke)

# Plug 1 — top-left. Body (4×4 box) with two prongs.
round_rect((x(2), y(5), x(8), y(9)))
line([(x(3), y(5)), (x(3), y(3))])
line([(x(7), y(5)), (x(7), y(3))])

# Plug 2 — bottom-right.
round_rect((x(16), y(15), x(22), y(19)))
line([(x(15), y(15)), (x(15), y(13))])
line([(x(19), y(15)), (x(19), y(13))])

# Cable: connect bottom of plug 1 (x=5,y=9) → curve down → S-curve → top of plug 2 (x=19,y=15).
# Use four quarter arcs for nice rounding.
r = (x(2.5) - x(0))  # arc radius in canvas units (~2.5 lucide units)
# Down stretch from plug 1
line([(x(5), y(9)), (x(5), y(11.5))])
# Arc bending right (centre at x=7.5, y=11.5; radius=2.5)
arc((x(5), y(9.5), x(10), y(13.5)), start=90, end=180)
# Middle horizontal
line([(x(7.5), y(13.5)), (x(16.5), y(13.5))])
# Wait — actually let me use an S shape:
# from (5,11.5) arc down-right to (7.5,14), straight to (16.5,14), arc up-right to (19,11.5), up to (19,13)
# Re-plan with cleaner numbers.

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d   = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=R, fill=BG_DARK, outline=BG_EDGE, width=3 * SCALE)
round_rect((x(2), y(5), x(8), y(9)))
line([(x(3), y(5)), (x(3), y(3))])
line([(x(7), y(5)), (x(7), y(3))])
round_rect((x(16), y(15), x(22), y(19)))
line([(x(15), y(15)), (x(15), y(13))])
line([(x(19), y(15)), (x(19), y(13))])

# S-shaped cable from (5,9) → (19,15)
# 1) drop from (5,9) to (5,11)
# 2) quarter arc curving right+down: centre (7,11), radius 2 → from (5,11) to (7,13)
# 3) straight to (17,13)
# 4) quarter arc: centre (17,15), radius 2 → from (17,13) to (19,15)? wait we want to end at top of plug2
# Plug 2 top is y=15. Let me end cable at (19,15) which is top edge of plug2 body — fine.
line([(x(5), y(9)),  (x(5), y(11))])
arc ((x(5), y(9), x(9), y(13)),    start=90,  end=180)  # arc from (5,11) curving to (7,13) — centre (7,11), radius 2
# Hmm PIL arc box defines the ellipse bounding box. Box (5,9)–(9,13) is a 4×4 centred at (7,11) radius 2.
# start=90 → bottom point (7,13). end=180 → left point (5,11). PIL draws clockwise from start? Actually PIL uses degrees increasing clockwise from 3 o'clock. So 0=right, 90=bottom, 180=left, 270=top.
# We want arc from (5,11) [angle 180] to (7,13) [angle 90]. Going clockwise from 90→180. So start=90, end=180.
line([(x(7), y(13)), (x(17), y(13))])
arc ((x(15), y(13), x(19), y(17)), start=180, end=270)  # arc from (17,13) [top of ellipse centre (17,15)] curving to (19,15) [right of ellipse]
# centre (17,15), radius 2. top=(17,13) angle=270, right=(19,15) angle=0. Going clockwise from 270→360(0).
# fix:
# Let me redo this one properly.

# Easier: skip arcs, just curve via joint=curve on a polyline w/ enough points so it reads as curved.
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d   = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=R, fill=BG_DARK, outline=BG_EDGE, width=3 * SCALE)
round_rect((x(2), y(5), x(8), y(9)))
line([(x(3), y(5)), (x(3), y(3))])
line([(x(7), y(5)), (x(7), y(3))])
round_rect((x(16), y(15), x(22), y(19)))
line([(x(15), y(15)), (x(15), y(13))])
line([(x(19), y(15)), (x(19), y(13))])

# Build a smooth cubic-bezier S-curve as a polyline.
def cubic(p0, p1, p2, p3, n=80):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        bx = u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0]
        by = u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
        out.append((bx, by))
    return out

p0 = (x(5),  y(9))
p1 = (x(5),  y(15))
p2 = (x(19), y(9))
p3 = (x(19), y(15))
d.line(cubic(p0, p1, p2, p3), fill=ORANGE, width=stroke, joint="curve")

OUT.parent.mkdir(parents=True, exist_ok=True)
img = img.resize((FINAL, FINAL), Image.LANCZOS)
img.save(OUT, "PNG")
print(f"wrote {OUT}  ({FINAL}x{FINAL})")
