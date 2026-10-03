"""Test the Whisper fallback wiring with a stand-in faster_whisper module (no model download).
    python test_transcribe.py <course_dir_copy>"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
calls = []


class _Seg:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


class WhisperModel:  # mimics faster_whisper.WhisperModel
    def __init__(self, name, device="cpu", compute_type="int8"):
        calls.append(("init", name, device, compute_type))

    def transcribe(self, path, vad_filter=True, language=None):
        calls.append(("transcribe", Path(path).name, Path(path).exists(), language))
        segs = [_Seg(0.0, 5.0, " Never chase losses."), _Seg(5.0, 9.0, " Stop after three losing trades.")]
        return iter(segs), types.SimpleNamespace(language="en")


sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=WhisperModel)
import udemy_process as up  # noqa: E402

d = Path(sys.argv[1])
media = d / "talk.wav"
media.write_bytes(b"RIFF....WAVEfmt ")  # content is irrelevant to the stand-in model
up.main(["transcribe", str(d), "--lecture", "1006", "--media", str(media), "--model", "base.en"])
lec = up.State(d).load("L006_1006")
assert lec["transcript"]["source"] == "whisper base.en" and len(lec["transcript"]["segments"]) == 2, lec["transcript"]
assert lec["needs_transcription"] is False
up.main(["transcribe", str(d), "--lecture", "1002", "--download"])  # Udemy-offered download, lowest quality
assert calls[-1][1] == "L002_1002.mp4" and calls[-1][2] is True, calls
assert not (d / "media" / "L002_1002.mp4").exists(), "downloaded media should be deleted afterwards"
try:
    up.main(["transcribe", str(d), "--lecture", "1001", "--download"])
    raise AssertionError("expected an exit: no Udemy download for 1001")
except SystemExit as e:
    assert "no download" in str(e), e
md = (d / "course.md").read_text(encoding="utf-8")
assert "Stop after three losing trades." in md and "(whisper base.en;" in md
up.main(["build", str(d / "manifest.json"), "--out", str(d)])  # rebuild must keep Whisper transcripts
assert up.State(d).load("L006_1006")["transcript"]["source"] == "whisper base.en"
print("transcribe OK")
