#!/bin/sh
# Turns a short clip of a talking face into a looping 640x480 fake camera feed:
# the clip is shrunk to webcam-like proportions and played back and forth.
# Usage: make_face_camera.sh INPUT.mp4 OUT.y4m [start] [duration]
set -e
in=$1; out=$2; ss=${3:-0}; t=${4:-0.75}
ffmpeg -v error -y -ss "$ss" -t "$t" -i "$in" -filter_complex \
  "[0:v]scale=320:320,pad=640:480:160:110:color=0xb8bcc0,fps=15,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1,loop=5:32767:0,format=yuv420p" \
  -an "$out"
