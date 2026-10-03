#!/usr/bin/env python3
"""Mock of the Udemy web API + CDN used to test udemy_manifest.js, udemy_frames.js and
udemy_process.py end to end. Generates its fixtures (captions, sprite, slides, office files,
PDFs, a short WebM video with on-screen text) into --root, then serves them.

    python mock_udemy.py --root /tmp/mock --port 8765
"""
from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COURSE_ID, SLUG = 4242, "test-trading-course"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SLIDES = [(0, 10, "Slide 1: Back to lay"), (10, 20, "Entry: odds between 2.0 and 4.0"),
          (20, 30, "Exit: green up at 10 percent")]


def vtt(cues):
    out = ["WEBVTT", ""]
    for i, (a, b, t) in enumerate(cues, 1):
        f = lambda s: f"00:{int(s // 60):02d}:{s % 60:06.3f}"
        out += [str(i), f"{f(a)} --> {f(b)}", t, ""]
    return "\n".join(out)


def minimal_pdf(text: str) -> bytes:
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def text_image(text: str, size=(1280, 720), fs=56):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", size, (250, 250, 250))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, fs)
    y = 120
    for line in text.split("\n"):
        d.text((80, y), line, fill=(20, 20, 20), font=font)
        y += int(fs * 1.5)
    return img


def make_fixtures(root: Path) -> None:
    cdn = root / "cdn"
    if (cdn / ".done").exists():
        return
    for sub in ("captions", "sprite", "slides", "res", "video", "ebook"):
        (cdn / sub).mkdir(parents=True, exist_ok=True)
    # captions: 1001 auto English; 1002 manual Spanish + manual English
    (cdn / "captions" / "1001_en_auto.vtt").write_text(vtt([
        (0, 4, "Welcome to the course. Today we learn back to lay trading."),
        (4, 9.5, "We only enter when the odds are between two and four."),
        (9.5, 15, "<c.colorE5E5E5>The exit is a green up</c> at ten percent profit &amp; no more."),
        (15, 22, "Stake two percent of the bank on each trade."),
        (22, 30, "That is the whole system."),
    ]), encoding="utf-8")
    (cdn / "captions" / "1002_es.vtt").write_text(vtt([(0, 5, "Hola y bienvenidos.")]), encoding="utf-8")
    (cdn / "captions" / "1002_en.vtt").write_text(vtt([
        (0, 6, "The lay strategy targets short priced favourites."),
        (6, 12, "Lay only when the favourite is under three point zero."),
    ]), encoding="utf-8")
    # video with on-screen text (VP9 WebM: Playwright Chromium lacks H.264)
    filt = ",".join(
        f"drawtext=fontfile={FONT}:text='{t.replace(':', chr(92) + ':')}':fontsize=56:fontcolor=black:"
        f"x=80:y=300:enable='between(t,{a},{b - 0.001})'" for a, b, t in SLIDES)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=1280x720:d=30:r=10",
                    "-vf", filt, "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
                    str(cdn / "video" / "1001.webm")], check=True)
    # same slides plus a "webcam" inset: dark 360x240 panel with a bright 120x120 head moving around
    # (overlay, not drawbox: in drawbox expressions "t" is the box thickness, not time)
    head = "880+240*(0.5+0.5*sin(2*PI*t/1.7))", "440+120*(0.5+0.5*sin(2*PI*t/1.3))"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=1280x720:d=30:r=10",
                    "-f", "lavfi", "-i", "color=c=0xF0E0C0:s=120x120:d=30:r=10", "-filter_complex",
                    f"[0:v]{filt},drawbox=x=880:y=440:w=360:h=240:color=0x202040@1:t=fill[bg];"
                    f"[bg][1:v]overlay=x='{head[0]}':y='{head[1]}':eval=frame:shortest=1",
                    "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
                    str(cdn / "video" / "1002.webm")], check=True)
    # thumbnail sprite: 6 tiles of 128x72 every 5 s, relative image URL in the VTT
    from PIL import Image
    sheet = Image.new("RGB", (128 * 3, 72 * 2), "white")
    cues = []
    for i in range(6):
        t = i * 5 + 2.5
        png = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", str(cdn / "video" / "1001.webm"),
                              "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                             check=True, capture_output=True).stdout
        tile = Image.open(io.BytesIO(png)).convert("RGB").resize((128, 72))
        x, y = (i % 3) * 128, (i // 3) * 72
        sheet.paste(tile, (x, y))
        cues.append((i * 5, i * 5 + 5, f"sprite_1001.jpg#xywh={x},{y},128,72"))
    sheet.save(cdn / "sprite" / "sprite_1001.jpg", quality=90)
    (cdn / "sprite" / "sprite_1001.vtt").write_text(vtt(cues), encoding="utf-8")
    # presentation slides
    text_image("Rule 1: Only UK flat races\nRule 2: Minimum 8 runners").save(cdn / "slides" / "1004_1.png")
    text_image("Rule 3: Lay price under 3.0").save(cdn / "slides" / "1004_2.png")
    # e-book (text PDF) and a scanned (image-only) PDF
    (cdn / "ebook" / "system_guide.pdf").write_bytes(minimal_pdf("Stake 2 percent of bank per selection"))
    text_image("Scanned checklist: avoid heavy ground").save(cdn / "res" / "scanned.pdf")
    # xlsx with formulas
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Staking"
    ws.append(["Bank", 1000])
    ws.append(["Stake %", 0.02])
    ws.append(["Stake", "=B1*B2"])
    wb.save(cdn / "res" / "staking_plan.xlsx")
    # zip with csv + docx + pptx
    docx = io.BytesIO()
    with zipfile.ZipFile(docx, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml",
                   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                   '<w:p><w:r><w:t>Never lay above 3.0</w:t></w:r></w:p>'
                   '<w:p><w:r><w:t>Check the going</w:t></w:r><w:r><w:tab/><w:t>daily</w:t></w:r></w:p>'
                   '</w:body></w:document>')
    pptx = io.BytesIO()
    with zipfile.ZipFile(pptx, "w") as z:
        z.writestr("ppt/slides/slide1.xml",
                   '<p:sld xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                   '<a:p><a:r><a:t>Pptx slide rule: no handicaps</a:t></a:r></a:p></p:sld>')
    with zipfile.ZipFile(cdn / "res" / "data.zip", "w") as z:
        z.writestr("results.csv", "date,horse,odds,result\n2024-01-02,Alpha,2.5,won\n")
        z.writestr("docs/rules.docx", docx.getvalue())
        z.writestr("docs/deck.pptx", pptx.getvalue())
        z.writestr("../evil.txt", "zip slip attempt")
        z.writestr("__MACOSX/._junk", "junk")
    (cdn / "res" / "notes_a.txt").write_text("First notes file: minimum 8 runners", encoding="utf-8")
    (cdn / "res" / "notes_b.txt").write_text("Second notes file: avoid odds-on favourites", encoding="utf-8")
    (cdn / ".done").write_text("ok")


def api_routes(base: str) -> dict:
    cdn = base + "/cdn"
    lec = {
        1001: {"asset": {"asset_type": "Video", "length": 30, "course_is_drmed": False,
                         "captions": [{"locale_id": "en_US", "source": "auto", "title": "English [Auto]",
                                       "url": f"{cdn}/captions/1001_en_auto.vtt?Expires=1&Signature=x"}],
                         "thumbnail_sprite": {"img_url": f"{cdn}/sprite/sprite_1001.jpg",
                                              "vtt_url": f"{cdn}/sprite/sprite_1001.vtt"},
                         "download_urls": None},
               "description": "<p>Intro notes: <b>read</b> the <a href='https://example.com/x'>guide</a></p>"},
        1002: {"asset": {"asset_type": "Video", "length": 12,
                         "captions": [{"locale_id": "es_ES", "source": "manual", "title": "Spanish", "url": f"{cdn}/captions/1002_es.vtt"},
                                      {"locale_id": "en_US", "source": "manual", "title": "English", "url": f"{cdn}/captions/1002_en.vtt"}],
                         "download_urls": {"Video": [{"label": "720", "file": f"{cdn}/video/1001.webm"},
                                                     {"label": "360", "file": f"{cdn}/video/1001.webm"}]}}},
        1003: {"asset": {"asset_type": "Article", "body": "<h2>Rules</h2><ul><li>UK flat only</li><li>8+ runners</li></ul>"
                                                          "<p>See <a href='https://example.com/rules'>rules</a> &amp; notes.</p>"
                                                          "<script>alert(1)</script>"}},
        1004: {"asset": {"asset_type": "Presentation", "slide_urls": [f"{cdn}/slides/1004_1.png", f"{cdn}/slides/1004_2.png"]}},
        1005: {"asset": {"asset_type": "E-Book", "filename": "system_guide.pdf",
                         "download_urls": {"E-Book": [{"label": "download", "file": f"{cdn}/ebook/system_guide.pdf?token=abc"}]}}},
        1006: {"asset": {"asset_type": "Video", "length": 600, "captions": []}},
    }
    res = {
        5001: {"asset_type": "File", "title": "Staking plan", "filename": "staking_plan.xlsx",
               "download_urls": {"File": [{"label": "download", "file": f"{cdn}/res/staking_plan.xlsx?sig=1"}]}},
        5003: {"asset_type": "File", "title": "Data pack", "filename": "data.zip",
               "download_urls": {"File": [{"label": "download", "file": f"{cdn}/res/data.zip"}]}},
        5004: {"asset_type": "File", "title": "Scanned checklist", "filename": "scanned.pdf",
               "download_urls": {"File": [{"label": "download", "file": f"{cdn}/res/scanned.pdf"}]}},
        5005: {"asset_type": "ExternalLink", "title": "Betfair site", "external_url": "https://www.betfair.com/"},
        5006: {"asset_type": "File", "title": "Notes v1", "filename": "notes.txt",
               "download_urls": {"File": [{"label": "download", "file": f"{cdn}/res/notes_a.txt"}]}},
        5007: {"asset_type": "File", "title": "Notes v2", "filename": "notes.txt",
               "download_urls": {"File": [{"label": "download", "file": f"{cdn}/res/notes_b.txt"}]}},
    }
    sup = {1001: [5001, 5002], 1002: [5003, 5005], 1003: [5006, 5007], 1005: [5004]}
    return {"lec": lec, "res": res, "sup": sup}


def curriculum(page: int, base: str):
    def L(i, title, atype):
        return {"_class": "lecture", "id": i, "title": title, "asset": {"asset_type": atype},
                "supplementary_assets": [{"id": s, "_class": "asset", "title": f"res {s}"}
                                         for s in api_routes(base)["sup"].get(i, [])]}
    if page == 1:
        res = [{"_class": "chapter", "id": 9001, "title": "Introduction"},
               L(1001, "Welcome", "Video"), L(1002, "The lay strategy", "Video")]
        nxt = f"{base}/api-2.0/courses/{COURSE_ID}/subscriber-curriculum-items/?page=2&page_size=200"
    else:
        res = [{"_class": "chapter", "id": 9002, "title": "Systems"},
               L(1003, "Rules summary", "Article"), L(1004, "Slides", "Presentation"),
               L(1005, "Ebook", "E-Book"), L(1006, "Long talk without captions", "Video"),
               {"_class": "quiz", "id": 7001, "title": "Check your understanding", "type": "simple-quiz"},
               {"_class": "practice", "id": 8001, "title": "Practice set"}]
        nxt = None
    return {"count": 10, "next": nxt, "previous": None, "results": res}


ASSESSMENTS = [
    {"_class": "assessment", "id": 1, "assessment_type": "multiple-choice", "correct_response": ["b"],
     "prompt": {"question": "<p>What odds range do we enter?</p>",
                "answers": ["<p>1.5 - 2.0</p>", "<p>2.0 - 4.0</p>", "<p>5.0+</p>"],
                "feedbacks": ["", "Correct - lecture 2", ""], "explanation": "<p>The rule is 2.0 to 4.0.</p>"}},
    {"_class": "assessment", "id": 2, "assessment_type": "multi-select", "correct_response": ["a", "c"],
     "prompt": {"question": "<p>Which filters apply?</p>", "answers": ["UK flat", "Handicaps", "8+ runners"]}},
]


class Handler(BaseHTTPRequestHandler):
    root: Path = Path(".")
    base: str = ""
    log_path: Path | None = None

    def log_message(self, fmt, *args):
        if self.log_path:
            with open(self.log_path, "a") as f:
                f.write((fmt % args) + "\n")

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path
        R = api_routes(self.base)
        m = None
        if p.startswith("/api-2.0/users/me/subscribed-courses/") and p.rstrip("/").endswith("subscribed-courses"):
            return self.send_json({"count": 2, "next": None, "results": [
                {"id": 1111, "title": "Other course", "published_title": "other-course", "url": "/course/other-course/"},
                {"id": COURSE_ID, "title": "Test Trading Course", "published_title": SLUG, "url": f"/course/{SLUG}/"}]})
        if p == f"/api-2.0/courses/{COURSE_ID}/":
            return self.send_json({"id": COURSE_ID, "title": "Test Trading Course", "published_title": SLUG,
                                   "url": f"/course/{SLUG}/", "headline": "Learn a lay system",
                                   "visible_instructors": [{"title": "Jane Trader"}],
                                   "description": "<p>A <b>test</b> course.</p>"})
        if p == f"/api-2.0/courses/{COURSE_ID}/subscriber-curriculum-items/":
            assert "fields[lecture]" in q or q.get("page") == ["2"], "fields missing"
            return self.send_json(curriculum(int(q.get("page", ["1"])[0]), self.base))
        m = re.match(rf"^/api-2.0/users/me/subscribed-courses/{COURSE_ID}/lectures/(\d+)/supplementary-assets/(\d+)/$", p)
        if m:
            r = R["res"].get(int(m.group(2)))
            return self.send_json(r) if r else self.send_json({"detail": "Not found."}, 404)
        m = re.match(rf"^/api-2.0/users/me/subscribed-courses/{COURSE_ID}/lectures/(\d+)/$", p)
        if m:
            d = R["lec"].get(int(m.group(1)))
            return self.send_json(d) if d else self.send_json({"detail": "Not found."}, 404)
        if p == "/api-2.0/quizzes/7001/assessments/":
            return self.send_json({"count": 2, "next": None, "results": ASSESSMENTS})
        if p.startswith(f"/course/{SLUG}/learn/lecture/"):
            lid = p.rstrip("/").split("/")[-1]
            vid = lid if (self.root / "cdn" / "video" / f"{lid}.webm").exists() else "1001"
            spa = "" if "nospa" in q else (  # like the real player: in-page navigation swaps the video
                "<script>addEventListener('popstate',function(){var id=location.pathname.replace(/\\/$/,'')"
                ".split('/').pop();var v=document.getElementById('v');document.title='Lecture '+id;"
                "v.src='/cdn/video/'+(id==='1002'?'1002':'1001')+'.webm?lecture='+id;v.load();});</script>")
            page = (f"<!doctype html><title>Lecture {lid}</title><body><h1>Lecture {lid}</h1>"
                    f"<video id=v src='/cdn/video/{vid}.webm' preload='auto' muted width=640></video>{spa}</body>")
            data = page.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if p.startswith("/cdn/"):
            f = (self.root / p.lstrip("/")).resolve()
            if not str(f).startswith(str(self.root.resolve())) or not f.is_file():
                self.send_response(404)
                self.end_headers()
                return None
            data = f.read_bytes()
            ctype = {".vtt": "text/vtt", ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg",
                     ".pdf": "application/pdf"}.get(f.suffix, "application/octet-stream")
            rng = self.headers.get("Range")
            if rng:
                a, _, b = rng.replace("bytes=", "").partition("-")
                a = int(a or 0)
                b = int(b) if b else len(data) - 1
                chunk = data[a:b + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {a}-{a + len(chunk) - 1}/{len(data)}")
            else:
                chunk = data
                self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            return self.wfile.write(chunk)
        self.send_json({"detail": "Not found."}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    root = Path(a.root)
    make_fixtures(root)
    Handler.root = root
    Handler.base = f"http://127.0.0.1:{a.port}"
    Handler.log_path = root / "requests.log"
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
