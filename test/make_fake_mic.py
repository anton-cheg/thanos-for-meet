"""Builds a looping 8 s fake microphone feed with one finger snap in it.

Usage: python3 make_fake_mic.py OUT.wav

  0.0-1.5 s  room noise
  1.5-3.5 s  speech-like voice (harmonics, syllables, "t"/"k" bursts)
  2.6-2.8 s  a long "ssss" hiss on top
  4.0 s      the snap: a ~3 ms click with a short reverb tail
  4.5-7.0 s  speech again
Chrome's fake audio capture device loops the file.
"""
import math
import random
import struct
import sys
import wave

RATE = 48000
DUR = 8.0
SNAP_AT = 4.0

random.seed(7)
n = int(RATE * DUR)
out = [0.0] * n


def add(start, samples):
    i0 = int(start * RATE)
    for i, s in enumerate(samples):
        if 0 <= i0 + i < n:
            out[i0 + i] += s


def highpassed_noise(count, amp):
    prev = 0.0
    res = []
    for _ in range(count):
        x = random.uniform(-1, 1)
        res.append((x - prev) * 0.5 * amp)
        prev = x
    return res


# room noise, slightly low-passed
lp = 0.0
for i in range(n):
    lp += (random.uniform(-1, 1) - lp) * 0.3
    out[i] += lp * 0.004


def speech(start, end):
    count = int((end - start) * RATE)
    res = []
    for i in range(count):
        t = i / RATE
        f0 = 130 + 25 * math.sin(t * 2.1)
        env = max(0.0, math.sin(math.pi * 4.5 * t)) ** 0.6
        s = sum(math.sin(2 * math.pi * f0 * k * t) / k for k in range(1, 12))
        res.append(0.12 * env * s)
    add(start, res)
    # plosive bursts right before syllables: short, high-frequency, then a vowel
    t = start + 0.05
    while t < end - 0.1:
        burst = highpassed_noise(int(0.012 * RATE), 0.35)
        add(t, [s * math.exp(-i / (0.004 * RATE)) for i, s in enumerate(burst)])
        t += 1 / 4.5 * 2


speech(1.5, 3.5)
speech(4.5, 7.0)
hiss = highpassed_noise(int(0.2 * RATE), 0.18)
add(2.6, [s * min(1, i / 2400, (len(hiss) - i) / 2400) for i, s in enumerate(hiss)])

# the snap: sharp click, a 2.8 kHz ring, and a quieter reverb tail
click = highpassed_noise(int(0.03 * RATE), 1.0)
snap = []
for i, s in enumerate(click):
    t = i / RATE
    ring = math.sin(2 * math.pi * 2800 * t) * math.exp(-t / 0.002)
    snap.append(0.8 * (s * math.exp(-t / 0.0015) + 0.6 * ring))
tail = highpassed_noise(int(0.25 * RATE), 0.08)
add(SNAP_AT, snap)
add(SNAP_AT + 0.003, [s * math.exp(-i / (0.05 * RATE)) for i, s in enumerate(tail)])

with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in out))
