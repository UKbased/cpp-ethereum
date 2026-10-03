"""Test screen-capture without a display: ImageGrab.grab and the clock are faked so that the
"screen" shows a test video's frames in real time.
    python test_screen_capture.py <video.webm> <course_dir> <lecture_id>"""
import io
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import PIL.ImageGrab  # noqa: E402
from PIL import Image  # noqa: E402

import udemy_process as up  # noqa: E402

video, course_dir, lecture = sys.argv[1:4]
shots = []
for t in range(30):
    png = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{t + 0.5}", "-i", video, "-frames:v", "1",
                          "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True).stdout
    shots.append(Image.open(io.BytesIO(png)).convert("RGB"))
clock = {"t": 1000.0}
time.time = lambda: clock["t"]
time.sleep = lambda s: clock.__setitem__("t", clock["t"] + max(0.0, s))
PIL.ImageGrab.grab = lambda bbox=None, all_screens=False: shots[min(int(clock["t"] - 1000.0), 29)]
up.main(["screen-capture", course_dir, "--lecture", lecture, "--seconds", "30", "--every", "1"])
raw = sorted((Path(course_dir) / "frames" / "_raw").glob(f"screen_{lecture}_*.json"))[-1]
data = up.read_json(raw)
ts = [f["t"] for f in data["frames"]]
print("kept at", ts)
assert len(ts) == 3 and ts[0] < 1 and 10 <= ts[1] < 12 and 20 <= ts[2] < 22, ts
print("screen-capture OK")
