/*
 * udemy_frames.js  (v1.0.0)
 * Personal-use helper: captures distinct still frames (slides, spreadsheets, charts) from
 * the lecture video that is open in this tab, for offline OCR.
 *
 * Run on a lecture page: https://www.udemy.com/course/<slug>/learn/lecture/<id>
 * It pauses the player, seeks through the video, draws frames into a canvas and keeps only
 * frames whose static content differs from the last kept one. The kept frames are saved as
 * one JSON download (JPEG data URLs with timestamps). Playback position is restored after.
 * It reads pixels from the player that is already showing you the video; it does not
 * download or decrypt the stream. If the video is DRM-protected the frames come out black
 * and the run stops with a message saying so.
 *
 *   udfStart({interval: 8})                 // sample every 8 s
 *   udfStart({times: [3.5, 41, 97.2]})      // or only at given seconds (e.g. from sprite-times)
 *   udfStatus()                             // progress / summary
 *   udfSaveAgain()                          // re-trigger the last download
 *   udfBatch([{id: 123, times: [...]}, {id: 124}], {interval: 8})
 *       // whole course with one injection: moves between lectures inside the player (no page
 *       // reload), captures each and saves one file per lecture. udfStatus() shows progress.
 *       // If the player does not follow in-page navigation it stops with "navigation failed";
 *       // then open lectures one by one instead (clicking in the course sidebar keeps the
 *       // script loaded; check typeof udfStart after any full page load).
 * Options: interval (8), times, delta (1.0), lo (0.015), motion (0.02), motionGap (45),
 *          maxGap (120), maxWidth (1600), quality (0.85), maxFrames (300), download, restore
 * Each sample at time t is paired with a second sample at t + delta. Motion is judged per 8x8
 * block of a 160x90 thumbnail: blocks that move (a webcam inset, a ticking price ladder:
 * moving now, moving when the reference frame was kept, or moving in 2+ of the last 6 pairs)
 * are ignored, and the frame is kept when >= lo of the remaining static pixels differ from
 * the last kept frame (a new slide or bullet). Screens with >= motion moving pixels are also
 * kept every motionGap seconds, and any visible change is kept at least every maxGap seconds.
 */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  var W = window;
  var S = (W.__udf = W.__udf || { status: 'idle' });
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var SW = 160, SH = 90, N = SW * SH, THR = 24, HIST = 6, BS = 8;
  var BW = Math.ceil(SW / BS), NB = BW * Math.ceil(SH / BS);
  var BLOCK = new Uint16Array(N);
  for (var bi0 = 0; bi0 < N; bi0++) BLOCK[bi0] = Math.floor(Math.floor(bi0 / SW) / BS) * BW + Math.floor((bi0 % SW) / BS);

  function waitFor(fn, timeoutMs, stepMs) {
    stepMs = stepMs || 250;
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout'));
        setTimeout(tick, stepMs);
      })();
    });
  }

  function findVideo() {
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    vids.sort(function (a, b) { return (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight); });
    var v = vids[0];
    return v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0 ? v : null;
  }

  // Seek and resolve once the new frame has been presented (or after a short fallback wait).
  function seekAndPaint(v, t, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false, seeked = false, painted = false;
      var finish = function () {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', onSeeked);
        resolve(seeked);
      };
      var maybe = function () { if (seeked && (painted || !v.requestVideoFrameCallback)) finish(); };
      var onSeeked = function () {
        seeked = true;
        maybe();
        if (!painted) setTimeout(finish, 1200);
      };
      v.addEventListener('seeked', onSeeked);
      if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(function () { painted = true; maybe(); });
      }
      setTimeout(finish, timeoutMs);
      v.currentTime = t;
    });
  }

  async function grab(v, small, t) {
    var ok = await seekAndPaint(v, t, 20000);
    if (!ok) return null;
    if (v.readyState < 2) {
      try { await waitFor(function () { return v.readyState >= 2; }, 5000); } catch (e) { return null; }
    }
    var ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, SW, SH);
    var d;
    try { d = ctx.getImageData(0, 0, SW, SH).data; } catch (e) {
      throw new Error('cannot read video pixels in the page (' + e.name + '); use the screenshot fallback');
    }
    var g = new Uint8Array(N);
    var sum = 0;
    for (var i = 0, j = 0; i < d.length; i += 4, j++) {
      var y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      g[j] = y;
      sum += y;
    }
    return { g: g, mean: sum / N, t: t };
  }

  function save(obj, filename) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 120000);
  }

  function status() {
    if (S.batch && S.batch.status === 'running') {
      return 'batch running: lecture ' + (S.batch.done + S.batch.failed.length + 1) + '/' + S.batch.total +
        ' (id ' + S.batch.current + ', ' + S.phase + ' ' + S.done + '/' + S.total + '), saved ' + S.batch.done +
        ', failed ' + S.batch.failed.length;
    }
    if (S.batch && S.batch.status !== 'running') {
      return 'batch ' + S.batch.status + ': saved ' + S.batch.done + '/' + S.batch.total +
        (S.batch.failed.length ? ', failed ' + JSON.stringify(S.batch.failed.slice(0, 10)) : '') +
        (S.batch.note ? ' - ' + S.batch.note : '');
    }
    var secs = S.startedAt ? Math.round((Date.now() - S.startedAt) / 1000) : 0;
    if (S.status === 'running') return 'running: ' + S.phase + ' ' + S.done + '/' + S.total + ', kept ' + S.kept + ', ' + secs + 's';
    if (S.status === 'done') return 'done: saved ' + S.file + ' ' + JSON.stringify(S.summary);
    if (S.status === 'error') return 'error: ' + S.error;
    return S.status;
  }

  async function run(opts) {
    var o = Object.assign({
      interval: 8, times: null, delta: 1.0, lo: 0.015, motion: 0.02, motionGap: 45, maxGap: 120,
      maxWidth: 1600, quality: 0.85, maxFrames: 300, start: 0.5, download: true, restore: true
    }, opts || {});
    if (S.status === 'running') return 'already running: ' + status();
    Object.assign(S, {
      status: 'running', phase: 'waiting for video', done: 0, total: 0, kept: 0, startedAt: Date.now(),
      error: null, file: null, summary: null, last: null
    });
    try {
      var v = await waitFor(findVideo, 45000).catch(function () {
        throw new Error('no playable <video> found on this page within 45 s (open a video lecture first)');
      });
      var lectureId = (location.pathname.match(/\/lecture\/(\d+)/) || [])[1] || 'unknown';
      var courseSlug = (location.pathname.match(/\/course\/([^/]+)/) || [])[1] || 'course';
      var orig = { t: v.currentTime, muted: v.muted };
      v.pause();
      v.muted = true;
      var dur = v.duration;
      var times = [];
      if (Array.isArray(o.times) && o.times.length) {
        times = o.times.map(Number).filter(function (t) { return isFinite(t) && t >= 0 && t < dur; });
      } else {
        for (var t0 = o.start; t0 < dur; t0 += o.interval) times.push(t0);
      }
      if (!times.length || dur - times[times.length - 1] > 2) times.push(Math.max(0, dur - 1.5));
      var seen = {};
      times = times.map(function (t) { return Math.round(t * 10) / 10; })
        .filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; })
        .sort(function (a, b) { return a - b; });
      S.total = times.length;
      S.phase = 'capturing';
      var small = document.createElement('canvas');
      small.width = SW; small.height = SH;
      var big = document.createElement('canvas');
      var last = null, lastMvb = null, lastT = -1e9, blackRun = 0, widths = [], hist = [];
      var frames = [];
      for (var i = 0; i < times.length; i++) {
        var t = times[i];
        if (!v.isConnected) v = await waitFor(findVideo, 20000);
        var A = await grab(v, small, t);
        S.done += 1;
        if (!A) continue;
        if (A.mean < 4) {
          blackRun += 1;
          if (blackRun >= 3 && frames.length === 0) {
            throw new Error('frames are black - the video is probably DRM-protected; use the screenshot fallback');
          }
          continue;
        }
        blackRun = 0;
        var B = null;
        if (t + o.delta < dur - 0.05) B = await grab(v, small, Math.round((t + o.delta) * 100) / 100);
        var mvb = null;
        if (B) {
          mvb = new Uint8Array(NB);
          for (var p = 0; p < N; p++) if (Math.abs(A.g[p] - B.g[p]) > THR) mvb[BLOCK[p]] = 1;
          hist.push(mvb);
          if (hist.length > HIST) hist.shift();
        }
        var c = { staticChange: 1, motion: 0, change: 1 };
        var keep = !last;
        if (last) {
          var dynB = new Uint8Array(NB);
          for (var b2 = 0; b2 < NB; b2++) {
            var cnt = 0;
            for (var h = 0; h < hist.length; h++) cnt += hist[h][b2];
            dynB[b2] = ((mvb && mvb[b2]) || (lastMvb && lastMvb[b2]) || cnt >= 2) ? 1 : 0;
          }
          var stat = 0, statCh = 0, ch = 0, dyn = 0;
          for (var q = 0; q < N; q++) {
            var changed = Math.abs(A.g[q] - last[q]) > THR;
            if (changed) ch++;
            if (dynB[BLOCK[q]]) dyn++; else { stat++; if (changed) statCh++; }
          }
          c = { staticChange: statCh / Math.max(1, stat), motion: dyn / N, change: ch / N };
          keep = c.staticChange >= o.lo ||
            (c.motion >= o.motion && t - lastT >= o.motionGap && c.change >= o.lo) ||
            (t - lastT >= o.maxGap && c.change >= 0.005);
        }
        if (!keep) continue;
        var K = B || A;  // the video currently shows K's frame
        var scale = Math.min(1, o.maxWidth / v.videoWidth);
        big.width = Math.round(v.videoWidth * scale);
        big.height = Math.round(v.videoHeight * scale);
        big.getContext('2d').drawImage(v, 0, 0, big.width, big.height);
        frames.push({ t: K.t, diff: Math.round(c.staticChange * 1000) / 1000, motion: Math.round(c.motion * 1000) / 1000,
          w: big.width, h: big.height, data: big.toDataURL('image/jpeg', o.quality) });
        widths.push(v.videoWidth);
        last = K.g; lastMvb = mvb; lastT = t; S.kept = frames.length;
        if (frames.length >= o.maxFrames) break;
      }
      if (o.restore) { await seekAndPaint(v, orig.t, 8000); v.muted = orig.muted; }
      widths.sort(function (a, b) { return a - b; });
      var medianW = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
      var result = {
        tool: 'udemy_frames.js', version: VERSION, generated_at: new Date().toISOString(), url: location.href,
        page_title: document.title, course_slug: courseSlug, lecture_id: lectureId, duration: dur,
        params: { interval: o.interval, times: (o.times || []).length, delta: o.delta, lo: o.lo, motion: o.motion,
          motionGap: o.motionGap, maxGap: o.maxGap, maxWidth: o.maxWidth },
        checked: S.done, median_source_width: medianW, frames: frames
      };
      S.file = 'frames_' + courseSlug.slice(0, 50) + '_' + lectureId + '.json';
      S.summary = { lecture_id: lectureId, duration_s: Math.round(dur), checked: S.done, kept: frames.length,
        median_source_width: medianW, low_res_warning: medianW > 0 && medianW < 1000 };
      S.last = result;
      if (o.download) save(result, S.file);
      S.status = 'done';
    } catch (e) {
      S.status = 'error';
      S.error = String((e && e.message) || e);
    }
    return status();
  }

  // Move to another lecture inside the single-page player, without a page load.
  async function gotoLecture(id) {
    if (new RegExp('/lecture/' + id + '(/|$|[?#])').test(location.pathname + '/') && findVideo()) return true;
    var prev = findVideo();
    var prevSrc = prev ? prev.currentSrc : null;
    var slug = (location.pathname.match(/\/course\/([^/]+)/) || [])[1];
    if (!slug) return false;
    history.pushState(history.state, '', '/course/' + slug + '/learn/lecture/' + id);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    try {
      await waitFor(function () {
        var v = findVideo();
        return v && v.currentSrc && v.currentSrc !== prevSrc ? v : null;
      }, 30000);
      await sleep(1500);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function batch(items, opts) {
    S.batch = { status: 'running', total: items.length, done: 0, failed: [], current: null, note: '' };
    S.status = 'idle';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      S.batch.current = it.id;
      var ok = await gotoLecture(it.id);
      if (!ok) {
        S.batch.failed.push({ id: it.id, error: 'navigation failed' });
        if (S.batch.done === 0 && S.batch.failed.length >= 2) {
          S.batch.status = 'stopped';
          S.batch.note = 'the player does not follow in-page navigation; open lectures one by one instead';
          return status();
        }
        continue;
      }
      var o = Object.assign({}, opts || {});
      if (it.times && it.times.length) o.times = it.times;
      await run(o);
      if (S.status === 'done') {
        S.batch.done += 1;
      } else {
        S.batch.failed.push({ id: it.id, error: S.error });
        if (/DRM|cannot read video pixels/.test(S.error || '') && S.batch.done === 0) {
          S.batch.status = 'stopped';
          S.batch.note = 'in-page capture is blocked (' + S.error + ')';
          return status();
        }
      }
      await sleep(1500);
    }
    S.batch.status = 'finished';
    return status();
  }

  W.udfBatch = function (items, opts) {
    if (S.status === 'running' || (S.batch && S.batch.status === 'running')) return 'already running: ' + status();
    batch(items || [], opts);
    return 'batch started for ' + (items || []).length + ' lectures; poll udfStatus()';
  };
  W.udfRun = run;
  W.udfStart = function (opts) {
    if (S.status === 'running' || (S.batch && S.batch.status === 'running')) return 'already running: ' + status();
    S.batch = null;
    run(opts);
    return 'started; poll udfStatus()';
  };
  W.udfStatus = status;
  W.udfSaveAgain = function () {
    if (!S.last) return 'nothing to save yet';
    save(S.last, S.file);
    return 'download triggered again: ' + S.file;
  };
  return 'udemy_frames.js ' + VERSION + ' loaded: udfStart({interval:8} | {times:[...]}), udfBatch([{id,times}]), udfStatus(), udfSaveAgain()';
})();
