"""Builds a looping fake camera feed: 4 s of an empty room, then a 'person' for 16 s.

Usage: python3 make_fake_camera.py OUT.y4m
Pipes raw frames into ffmpeg, which writes the .y4m Chrome's fake capture device reads.
"""
import math
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H, FPS = 480, 270, 15
EMPTY_S, PERSON_S = 4, 16


def room():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / H
        d.line((0, y, W, y), fill=(int(214 - 40 * k), int(220 - 45 * k), int(228 - 50 * k)))
    d.rectangle((0, 200, W, H), fill=(150, 128, 104))           # floor
    d.rectangle((330, 30, 450, 200), fill=(236, 236, 230))       # curtain
    for x in range(335, 450, 12):
        d.line((x, 30, x, 200), fill=(205, 205, 198), width=3)
    d.ellipse((50, 40, 90, 80), fill=(255, 244, 205))            # lamp
    d.line((70, 0, 70, 40), fill=(120, 100, 60), width=3)
    return img


def person(base, t):
    img = base.copy()
    d = ImageDraw.Draw(img)
    cx = 220 + 12 * math.sin(t * 1.3)
    d.rounded_rectangle((cx - 85, 160, cx + 85, H + 30), 50, fill=(28, 30, 36))      # torso
    d.rectangle((cx - 22, 140, cx + 22, 172), fill=(214, 160, 130))                 # neck
    d.ellipse((cx - 42, 58, cx + 42, 158), fill=(222, 170, 140))                    # face
    d.pieslice((cx - 45, 50, cx + 45, 120), 180, 360, fill=(48, 34, 28))            # hair
    d.rounded_rectangle((cx + 20, 150, cx + 64, 236), 10, fill=(196, 170, 220))     # phone
    return img


base = room()
ff = subprocess.Popen(
    ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
     "-r", str(FPS), "-i", "-", "-pix_fmt", "yuv420p", sys.argv[1]],
    stdin=subprocess.PIPE,
)
for i in range((EMPTY_S + PERSON_S) * FPS):
    t = i / FPS
    frame = base if t < EMPTY_S else person(base, t)
    ff.stdin.write(frame.filter(ImageFilter.GaussianBlur(0.6)).tobytes())
ff.stdin.close()
sys.exit(ff.wait())
