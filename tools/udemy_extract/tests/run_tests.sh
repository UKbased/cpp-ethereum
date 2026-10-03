#!/usr/bin/env bash
# Full test: unit tests, then mock Udemy server + Chromium (both JS scripts) + Python pipeline.
# Needs python3 (pillow pypdf pypdfium2 openpyxl, optional rapidocr_onnxruntime), node with
# playwright + Chromium, ffmpeg with libvpx and drawtext.   Usage: tests/run_tests.sh [workdir]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
WORK=${1:-$(mktemp -d)}
PORT=${PORT:-8765}
export PLAYWRIGHT_MODULE=${PLAYWRIGHT_MODULE:-playwright}
rm -rf "$WORK/downloads" "$WORK/course"
python3 "$HERE/test_scene_detector.py"
python3 "$HERE/mock_udemy.py" --root "$WORK/mock" --port "$PORT" &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/api-2.0/courses/4242/" && break
  sleep 1
done
node "$HERE/e2e_browser.mjs" "http://127.0.0.1:$PORT" "$WORK/downloads"
python3 "$ROOT/udemy_process.py" build "$WORK"/downloads/udemy_manifest_*.json --out "$WORK/course"
python3 "$ROOT/udemy_process.py" sprite-times "$WORK/course"
python3 "$ROOT/udemy_process.py" frame-plan "$WORK/course"
python3 "$ROOT/udemy_process.py" frames "$WORK/course" "$WORK/downloads/frames_*.json"
python3 "$HERE/test_screen_capture.py" "$WORK/mock/cdn/video/1002.webm" "$WORK/course" 1006
python3 "$ROOT/udemy_process.py" frames "$WORK/course" "$WORK/course/frames/_raw/screen_1006_*.json"
python3 "$ROOT/udemy_process.py" build "$WORK"/course/manifest.json --out "$WORK/course" > /dev/null  # rebuild keeps frames
python3 "$ROOT/udemy_process.py" status "$WORK/course"
python3 "$HERE/check_course.py" "$WORK/course"
rm -rf "$WORK/course_copy" && cp -r "$WORK/course" "$WORK/course_copy"
python3 "$HERE/test_transcribe.py" "$WORK/course_copy" > /dev/null && echo "transcribe OK"
python3 "$HERE/test_append.py" "$WORK/course_copy" | tail -1
echo "ALL TESTS PASSED"
