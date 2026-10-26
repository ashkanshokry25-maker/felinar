#!/bin/bash
# Generates small deterministic test media with ffmpeg (9.0.2, libx264/libvpx-vp9/libopus/aac). 20 s clips.
set -e
cd "$(dirname "$0")/www/media"
V=(-f lavfi -i testsrc2=duration=20:size=480x270:rate=25)
A=(-f lavfi -i sine=frequency=440:duration=20:sample_rate=44100)
ffmpeg -v error -y "${V[@]}" "${A[@]}" -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 25 -b:v 900k -c:a aac -b:a 64k -movflags +faststart clip-faststart.mp4
ffmpeg -v error -y "${V[@]}" "${A[@]}" -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 25 -b:v 900k -c:a aac -b:a 64k clip-moovend.mp4
ffmpeg -v error -y "${V[@]}" "${A[@]}" -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 25 -b:v 900k -c:a aac -b:a 64k -movflags frag_keyframe+empty_moov+default_base_moof clip-frag.mp4
ffmpeg -v error -y "${V[@]}" "${A[@]}" -c:v libvpx-vp9 -b:v 700k -deadline realtime -cpu-used 8 -c:a libopus -b:a 48k clip.webm
ffmpeg -v error -y "${A[@]}" -c:a aac -b:a 96k -movflags +faststart tone.m4a
ffmpeg -v error -y "${A[@]}" -c:a libmp3lame -b:a 96k tone.mp3
ls -l
