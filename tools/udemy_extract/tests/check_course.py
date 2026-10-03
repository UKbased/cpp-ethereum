"""Assertions on the course folder produced by run_tests.sh."""
import json
import sys
from pathlib import Path

d = Path(sys.argv[1])
md = (d / "course.md").read_text(encoding="utf-8")
ocr = any(json.loads(p.read_text()).get("frames_info", {}).get("ocr") for p in (d / "state" / "items").glob("L*.json"))
must = [
    "We only enter when the odds are between two and four.",          # auto captions, tags + entities cleaned
    "green up at ten percent profit & no more",
    "Lay only when the favourite is under three point zero.",          # manual English chosen over Spanish
    "B3: =B1*B2",                                                      # Excel formula kept
    "Stake 2 percent of bank per selection",                           # text PDF via pypdf
    "Never lay above 3.0", "Pptx slide rule: no handicaps", "2024-01-02,Alpha,2.5,won",  # zip contents
    "- UK flat only\n- 8+ runners", "See rules (https://example.com/rules) & notes.",     # article
    "b) 2.0 - 4.0 [correct]", "c) 8+ runners [correct]", "Explanation: The rule is 2.0 to 4.0.",  # quiz
    "https://www.betfair.com/", "HTTP 404",
    "First notes file: minimum 8 runners", "Second notes file: avoid odds-on favourites",  # same file name twice
    "resources/L003_1003/notes_2.txt",
]
if ocr:
    must += ["odds between 2.0 and 4.0", "green up at 10 percent", "Minimum 8 runners",
             "Scanned checklist: avoid heavy ground", "on screen (frames/L002_1002/"]
missing = [m for m in must if m not in md]
assert not missing, f"missing from course.md: {missing}"
assert "alert(1)" not in md, "script content leaked into article text"
assert not list(d.rglob("evil.txt")), "zip slip entry was extracted"
assert "Hola" not in md, "Spanish captions should not be used"
idx = json.loads((d / "course_index.json").read_text())
assert len(idx["items"]) == 8, len(idx["items"])
print(f"course folder OK ({'with' if ocr else 'without'} OCR checks)")
