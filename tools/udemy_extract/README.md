# Udemy course extraction toolkit (personal use)

Turns Udemy courses **you have bought** into a local text knowledge base: transcripts,
on-screen text (OCR), lecture articles, downloadable resources (PDF, Excel with formulas,
Word, PowerPoint, zip, images) and quizzes. The goal is to pin down the strategies a course
teaches precisely enough to backtest them.

Everything stays on your machine. Nothing here downloads or decrypts video streams. It reads
what the course player already shows you, through your own logged-in browser.

| File | Runs where | Does |
|---|---|---|
| `udemy_manifest.js` | logged-in udemy.com tab | one JSON per course: curriculum, caption links, article text, resource links, quizzes |
| `udemy_frames.js` | a lecture page | captures distinct frames (slides, sheets, charts) and saves them as one JSON per lecture |
| `udemy_process.py` | terminal | builds the course folder, extracts text, runs OCR, Whisper fallback, writes `course.md` |
| `tests/` | dev only | mock Udemy server, Chromium end-to-end test, unit tests (`tests/run_tests.sh`) |

## Setup (Windows)

```bat
py -m venv %USERPROFILE%\udemy-venv
%USERPROFILE%\udemy-venv\Scripts\pip install -r requirements.txt
```

If the OCR package fails to install, use `pip install rapidocr onnxruntime`, or install
Tesseract and `pip install pytesseract`. Only lectures without captions need
`pip install faster-whisper`, and it runs fine on a CPU.

## Workflow for one course

1. **Manifest.** Use a udemy.com tab that is logged in, for example the order page. Evaluate
   the whole of `udemy_manifest.js` in the page. Then run `udmListCourses()` to see ids and
   slugs, `udmStart('<slug or id>')` to start, and `udmStatus()` every 10–20 s until it says
   `done`. The file `udemy_manifest_<id>_<slug>.json` lands in Downloads. Do not navigate
   that tab while it runs.
2. **Build, straight away.** The caption and resource links are signed and expire within
   hours.
   `python udemy_process.py build "%USERPROFILE%\Downloads\udemy_manifest_<id>_<slug>.json" --out <courses>\<id>_<slug>`
3. **Frames for OCR.** `python udemy_process.py sprite-times <dir>` then
   `python udemy_process.py frame-plan <dir>`. Each output line is a lecture URL and a
   `udfStart(...)` call. For each one, open the URL in the tab and set the player quality to
   the highest available (once is usually enough). Evaluate `udemy_frames.js` after every
   page load, run the printed `udfStart(...)`, and poll `udfStatus()` until `done`.
   - `frames are black` means the video is DRM-protected. `cannot read video pixels` means
     the page will not expose them. Either run
     `skip-frames <dir> --lecture <id> --reason "..."`, or use the screen fallback: play the
     lecture in a visible, unobstructed window and run
     `screen-capture <dir> --lecture <id> --seconds <n> --speed <player speed> [--bbox x1,y1,x2,y2]`.
   - `low_res_warning: true` means the player served a small rendition. Raise the quality
     and capture again.
4. **OCR the frames.** `python udemy_process.py frames <dir> "%USERPROFILE%\Downloads\frames_*.json"`.
   This moves the JSON files into `<dir>\frames\_raw`.
5. **Lectures without captions** (listed by `status`). If the course offers Udemy's own
   lecture download, run `transcribe <dir> --lecture <id> --download`. Otherwise record the
   audio while the lecture plays and run `transcribe <dir> --lecture <id> --media <file>`.
6. **Check.** `python udemy_process.py status <dir>`, then read `course.md`. The per-lecture
   copies are in `lectures\`, and the full resource texts sit next to each file as `*.txt`.
7. **Specify strategies.** Write `strategies.md` and `strategies.yaml` in the course folder
   using the template below.

`build` can be re-run at any time. It keeps captured frames and Whisper transcripts, and it
skips files that were already downloaded.

## Rules

- **Personal use only.** Never commit, upload or share course content. If the courses
  folder is inside a git repository, add it to `.git/info/exclude`.
- **One course at a time.** Keep the scripts' pacing as it is. They wait between calls and
  stop on login or bot checks. Never try to get past a login, captcha or bot check.
- **Read only.** Make no purchases, reviews, Q&A posts or account changes.
- **No stream ripping.** The only video download allowed is Udemy's own lecture download
  link, when the instructor offers it, for Whisper.

## Strategy spec template (`strategies.yaml`)

```yaml
course: <title>
course_url: <url>
extracted: <date>
strategies:
  - id: S01
    name: <as the instructor calls it>
    category: <pre-off trade | in-play trade | back system | lay system | dutching | staking plan | ...>
    market: <sport / country / race type / market type, e.g. UK & IRE horse racing WIN market>
    sources: [{lecture: L012, title: "...", at: "04:30"}]   # where each rule is stated
    summary: <one paragraph in plain words>
    selection_filters: [<every filter, with exact numbers>]
    timing: <when the decision is made, e.g. 10 min before the off; in play after 2f>
    entry: <precise conditions, order type, price>
    exit: <green-up / stop-loss / time stop / trade-out rules>
    staking: <level, % of bank, liability-based, progression; with numbers>
    costs: <commission and other assumptions the course uses>
    parameters: [{name: ..., course_value: ..., test_range: ...}]
    data_needed: [{field: ..., candidate_sources: [Betfair historical data, Racing Post, Timeform, ...]}]
    claimed_results: <strike rate, ROI, P/L the instructor claims, with the source>
    worked_examples: [<numeric examples from the course, used to check a backtest implementation>]
    ambiguities: [<anything not pinned down>]
    assumptions_for_backtest: [<how each ambiguity is resolved for a first test>]
    pseudocode: |
      <step by step>
    testability: <high | medium | low, and why>
```
