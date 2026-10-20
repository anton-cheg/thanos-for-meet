"""Draws the extension icon: a half-dissolved figure on a purple gauntlet-gold disc."""
import random
from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
for r in range(S // 2, 0, -1):
    k = r / (S / 2)
    d.ellipse((S / 2 - r, S / 2 - r, S / 2 + r, S / 2 + r),
              fill=(int(70 + 60 * (1 - k)), int(40 + 20 * (1 - k)), int(140 + 60 * (1 - k)), 255))

fig = Image.new("L", (S, S), 0)
f = ImageDraw.Draw(fig)
f.ellipse((186, 96, 306, 216), fill=255)            # head
f.rounded_rectangle((126, 236, 366, 470), 90, fill=255)  # shoulders
circle = Image.new("L", (S, S), 0)
ImageDraw.Draw(circle).ellipse((0, 0, S, S), fill=255)

random.seed(7)
gold = (246, 196, 83, 255)
px = fig.load()
for y in range(S):
    for x in range(S):
        if px[x, y] and x > 250 + 60 * random.random() - 30 + (y - 280) * 0.15:
            px[x, y] = 0
solid = Image.new("RGBA", (S, S), gold)
img.paste(solid, (0, 0), Image.composite(fig, Image.new("L", (S, S), 0), circle))
for _ in range(260):
    x = random.uniform(250, 470)
    y = random.uniform(90, 470)
    s = random.uniform(6, 18) * (1 - (x - 250) / 300)
    if (x - S / 2) ** 2 + (y - S / 2) ** 2 < (S / 2 - 20) ** 2:
        d.rectangle((x, y, x + s, y + s), fill=gold)

for size in (16, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"icons/icon{size}.png")
