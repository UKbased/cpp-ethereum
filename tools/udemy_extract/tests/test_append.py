"""frames --append merges a second capture into the frames already stored for a lecture.
    python test_append.py <course_dir_copy>"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import udemy_process as up  # noqa: E402

d = Path(sys.argv[1])
before = up.State(d).load("L006_1006")["frames"]
raw = sorted((d / "frames" / "_raw").glob("screen_1006_*.json"))[0]
data = json.loads(raw.read_text())
data["frames"] = [dict(data["frames"][1], t=95.0)]
extra = d / "extra_1006.json"
extra.write_text(json.dumps(data))
up.main(["frames", str(d), str(extra), "--append", "--ocr", "none"])
after = up.State(d).load("L006_1006")["frames"]
assert [f["t"] for f in after] == [f["t"] for f in before] + [95.0], after
assert not extra.exists() and list((d / "frames" / "_raw").glob("extra_1006*.json"))
up.main(["frames", str(d), str(raw), "--ocr", "none"])  # same name already archived: must not fail
print("append OK")
