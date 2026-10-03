"""Unit test: the scene detector keeps each slide (and an added bullet) once and ignores a
moving webcam-like inset, whether its texture moves with it or is fixed to the screen."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from udemy_process import SceneDetector  # noqa: E402

W, H = 160, 90
LINES = {0: [(10, 5), (20, 5), (30, 5)], 1: [(14, 20), (26, 20), (40, 20)], 2: [(12, 8), (36, 8), (48, 8)]}


def frame(slide, box_x, extra_bullet, texture_moves):
    px = bytearray([250]) * (W * H)
    for row, x0 in list(LINES[slide]) + ([(60, 5)] if extra_bullet else []):
        for y in range(row, row + 4):
            for x in range(x0, x0 + 60):
                px[y * W + x] = 20
    for y in range(55, 85):
        for x in range(100 + box_x, 115 + box_x):
            u = (x - box_x) if texture_moves else x
            px[y * W + x] = 200 if (u + y) % 2 else 40
    return bytes(px)


def run(texture_moves):
    det, kept = SceneDetector(), []
    for i, t in enumerate(range(0, 60, 2)):
        slide = 0 if t < 20 else (1 if t < 40 else 2)
        bullet = slide == 1 and t >= 30
        a = frame(slide, (i * 13) % 40, bullet, texture_moves)
        b = frame(slide, (i * 13 + 7) % 40, bullet, texture_moves)
        keep, _ = det.decide(float(t), a, b)
        if keep:
            det.kept(float(t), a)
            kept.append(t)
    return kept


for moves in (True, False):
    got = run(moves)
    print(f"texture moves with object={moves}: kept at {got}")
    assert got == [0, 20, 30, 40], got
print("scene detector OK")
