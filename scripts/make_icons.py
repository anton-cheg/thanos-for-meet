"""Draws the extension icon: pixel-art Clawd on a dark rounded tile."""
from PIL import Image, ImageDraw

S = 512
CELL = 12
CLAWD = (215, 119, 87, 255)
INK = (27, 19, 16, 255)

# Same grid as src/inject.js: (row, x0, x1)
rows = [(y, 6, 30) for y in range(4)] + [(y, 2, 34) for y in (4, 5)] + [(y, 6, 30) for y in range(6, 14)]
legs = [(x, 14, 2) for x in (8, 12, 22, 26)]
eyes = [10, 24]

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((0, 0, S - 1, S - 1), 110, fill=(28, 24, 22, 255))
ox = (S - 36 * CELL) // 2
oy = (S - 16 * CELL) // 2
cell = lambda x, y: (ox + x * CELL, oy + y * CELL)
for y, x0, x1 in rows:
    d.rectangle((*cell(x0, y), cell(x1, y + 1)[0] - 1, cell(x1, y + 1)[1] - 1), fill=CLAWD)
for x, y, h in legs:
    d.rectangle((*cell(x, y), cell(x + 2, y + h)[0] - 1, cell(x + 2, y + h)[1] - 1), fill=CLAWD)
for x in eyes:
    d.rectangle((*cell(x, 1), cell(x + 2, 4)[0] - 1, cell(x + 2, 4)[1] - 1), fill=INK)

for size in (16, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"icons/icon{size}.png")
