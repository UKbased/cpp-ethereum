/*
 * udemy_manifest.js  (v1.0.0)
 * Personal-use helper: builds a JSON manifest of ONE Udemy course you are enrolled in.
 *
 * Run it inside a logged-in https://www.udemy.com tab, either by pasting it into the
 * DevTools console or through a browser tool that evaluates JavaScript in the page.
 * It uses your existing login and Udemy's own web API (the same calls the course player
 * makes) to collect:
 *   - course info and the full curriculum (sections, lectures, quizzes)
 *   - each lecture's caption-track URLs, article text, lecture notes, slide image URLs
 *   - downloadable resource links and external links attached to lectures
 *   - quiz questions with answers and explanations
 *   - thumbnail-sprite URLs (used offline to find slide changes for OCR)
 * The result is saved as one JSON file through a normal browser download.
 * It never fetches, downloads or decrypts video streams.
 *
 * Signed URLs inside the manifest (captions, resources) expire after some hours,
 * so process the manifest soon after it is saved.
 *
 *   udmListCourses()            -> enrolled courses (id, slug, title), newest first if supported
 *   udmStart('slug-or-id')      -> starts in the background and returns at once
 *   udmStatus()                 -> one-line progress, or the final summary
 *   udmSaveAgain()              -> re-triggers the download if the browser blocked it
 *   await udmRun('slug-or-id')  -> same as udmStart but waits for the end
 * Keep the tab on a udemy.com page (do not navigate it) until udmStatus() says "done".
 */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  var W = window;
  var S = (W.__udm = W.__udm || { status: 'idle' });
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var CURRICULUM_FIELDS = [
    'fields[lecture]=title,object_index,is_published,sort_order,created,asset,supplementary_assets,description,is_free',
    'fields[quiz]=title,object_index,is_published,sort_order,type,description',
    'fields[practice]=title,object_index,is_published,sort_order',
    'fields[chapter]=title,object_index,is_published,sort_order,description',
    'fields[asset]=title,filename,asset_type,status,time_estimation,is_external,length'
  ].join('&');
  var LECTURE_FIELDS = 'fields[lecture]=title,asset,description,download_url,is_free' +
    '&fields[asset]=asset_type,title,filename,length,time_estimation,captions,thumbnail_sprite,' +
    'slides,slide_urls,download_urls,external_url,body,course_is_drmed';
  var RESOURCE_FIELDS = 'fields[asset]=download_urls,external_url,asset_type,filename,title,body';
  var QUIZ_FIELDS = 'fields[assessment]=id,assessment_type,prompt,correct_response,section,question_plain,related_lectures';
  var COURSE_FIELDS = 'fields[course]=id,title,url,published_title,headline,visible_instructors,content_info,' +
    'num_published_lectures,locale,created,last_update_date,description';

  function apiUrl(path) {
    if (/^https?:/i.test(path)) return path;
    return location.origin + '/api-2.0/' + path.replace(/^\/+/, '');
  }

  function httpError(msg, status) { var e = new Error(msg); e.status = status; return e; }
  function isFatal(e) { return e && (e.status === 401 || e.status === 'nonjson'); }
  function msg(e) { return String((e && e.message) || e); }

  async function api(path, o) {
    var url = apiUrl(path);
    var last = null;
    for (var attempt = 0; attempt < 5; attempt++) {
      var r;
      try {
        r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } });
      } catch (e) { last = e; await sleep(3000 * (attempt + 1)); continue; }
      if (r.status === 429 || r.status >= 500) {
        last = httpError('HTTP ' + r.status + ' ' + url, r.status);
        await sleep(15000 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw httpError('HTTP ' + r.status + ' ' + url, r.status);
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) {
        throw httpError('Non-JSON reply (' + ct + ') from ' + url +
          ' - probably a login or bot check. Stop and look at the browser tab.', 'nonjson');
      }
      var j = await r.json();
      await sleep(o.delayMs);
      return j;
    }
    throw last || new Error('request failed: ' + url);
  }

  async function paged(path, o) {
    var out = [];
    var next = path;
    while (next) {
      var page = await api(next, o);
      var res = Array.isArray(page) ? page : (page.results || []);
      for (var i = 0; i < res.length; i++) out.push(res[i]);
      next = (!Array.isArray(page) && page.next) ? page.next : null;
    }
    return out;
  }

  function slugFrom(x) {
    var s = String(x).trim();
    var m = s.match(/\/course\/([^/?#]+)/);
    return m ? m[1] : s.replace(/^\/+|\/+$/g, '');
  }

  async function resolveCourseId(course, o) {
    if (/^\d+$/.test(String(course).trim())) return Number(String(course).trim());
    var slug = slugFrom(course);
    var F = 'fields[course]=id,url,title,published_title';
    var match = function (c) {
      return c && (c.published_title === slug ||
        String(c.url || '').replace(/\/+$/, '').slice(-('/course/' + slug).length) === '/course/' + slug);
    };
    try {
      var res = await api('users/me/subscribed-courses/?' + F + '&page_size=50&search=' +
        encodeURIComponent(slug.replace(/-/g, ' ')), o);
      var hit = (res.results || []).filter(match)[0];
      if (hit) return hit.id;
    } catch (e) { if (isFatal(e)) throw e; }
    try {
      var all = await paged('users/me/subscribed-courses/?' + F + '&page_size=100', o);
      var hit2 = all.filter(match)[0];
      if (hit2) return hit2.id;
    } catch (e) { if (isFatal(e)) throw e; }
    var r = await fetch(location.origin + '/course/' + slug + '/', { credentials: 'include' });
    var html = await r.text();
    var m = html.match(/data-clp-course-id="(\d+)"/) || html.match(/&quot;courseId&quot;:\s*(\d+)/) ||
      html.match(/"courseId"\s*:\s*(\d+)/) || html.match(/course_id&quot;:\s*(\d+)/);
    if (m) return Number(m[1]);
    throw new Error('Could not find the course id for "' + slug +
      '". Pass the numeric id instead; udmListCourses() lists ids.');
  }

  async function listCourses(n) {
    n = n || 20;
    var F = 'fields[course]=id,url,title,published_title';
    var orders = ['-enroll_time', '-last_accessed', ''];
    for (var i = 0; i < orders.length; i++) {
      try {
        var res = await api('users/me/subscribed-courses/?' + F + '&page_size=' + n +
          (orders[i] ? '&ordering=' + orders[i] : ''), { delayMs: 300 });
        return (orders[i] ? 'ordering ' + orders[i] : 'default ordering') + '\n' +
          (res.results || []).map(function (c) { return c.id + '\t' + c.published_title + '\t' + c.title; }).join('\n');
      } catch (e) { if (isFatal(e)) throw e; }
    }
    throw new Error('could not list enrolled courses');
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

  function assetOf(it) { return (it.details && it.details.asset) || it.asset || {}; }

  function summarize(m) {
    var L = m.curriculum.filter(function (x) { return x._class === 'lecture'; });
    var types = {};
    var caps = 0, res = 0, drm = false, secs = 0;
    L.forEach(function (x) {
      var a = assetOf(x);
      types[a.asset_type || '?'] = (types[a.asset_type || '?'] || 0) + 1;
      if ((a.captions || []).length) caps += 1;
      res += (x.resources || x.supplementary_assets || []).length;
      if (a.course_is_drmed) drm = true;
      secs += Number(a.length || a.time_estimation || 0);
    });
    return {
      title: m.course.title, course_id: m.course_id, lectures: L.length, video_hours: Math.round(secs / 36) / 100,
      lectures_with_captions: caps, asset_types: types, resources: res,
      quizzes: m.curriculum.filter(function (x) { return x._class === 'quiz'; }).length,
      drm_flag: drm, errors: m.errors.length
    };
  }

  function status() {
    var secs = S.startedAt ? Math.round((Date.now() - S.startedAt) / 1000) : 0;
    if (S.status === 'running') {
      return 'running: ' + S.phase + ' ' + S.done + '/' + S.total + ', errors ' + S.errors.length + ', ' + secs + 's';
    }
    if (S.status === 'done') {
      return 'done: saved ' + S.file + ' ' + JSON.stringify(S.summary) +
        (S.errors.length ? ' | first errors: ' + JSON.stringify(S.errors.slice(0, 3)) : '');
    }
    if (S.status === 'error') return 'error: ' + S.error + ' (progress ' + S.done + '/' + S.total + ')';
    return S.status;
  }

  async function run(course, opts) {
    var o = Object.assign({
      delayMs: 700, includeQuizzes: true, includeResources: true, download: true, maxConsecutiveErrors: 6
    }, opts || {});
    if (S.status === 'running') return 'already running: ' + status();
    Object.assign(S, {
      status: 'running', phase: 'resolving course', done: 0, total: 0, errors: [], startedAt: Date.now(),
      course: String(course), file: null, manifest: null, summary: null, error: null
    });
    try {
      var id = await resolveCourseId(course, o);
      S.phase = 'course info';
      var info;
      try { info = await api('courses/' + id + '/?' + COURSE_FIELDS, o); } catch (e) {
        if (isFatal(e)) throw e;
        S.errors.push({ where: 'course info', error: msg(e) });
        info = { id: id };
      }
      S.phase = 'curriculum';
      var items = await paged('courses/' + id + '/subscriber-curriculum-items/?page_size=200&' +
        CURRICULUM_FIELDS + '&caching_intent=True', o);
      var nLect = items.filter(function (x) { return x._class === 'lecture'; }).length;
      var nQuiz = items.filter(function (x) { return x._class === 'quiz'; }).length;
      S.total = nLect + (o.includeQuizzes ? nQuiz : 0);
      S.phase = 'items';
      var consecutive = 0, sectionN = 0, sectionTitle = '', lectureN = 0, quizN = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it._class === 'chapter') { sectionN += 1; sectionTitle = it.title; it.section_n = sectionN; continue; }
        it.section_n = sectionN;
        it.section_title = sectionTitle;
        if (it._class === 'lecture') { lectureN += 1; it.lecture_n = lectureN; }
        if (it._class === 'quiz') { quizN += 1; it.quiz_n = quizN; }
        try {
          if (it._class === 'lecture') {
            it.details = await api('users/me/subscribed-courses/' + id + '/lectures/' + it.id + '/?' + LECTURE_FIELDS, o);
            if (o.includeResources && (it.supplementary_assets || []).length) {
              it.resources = [];
              for (var k = 0; k < it.supplementary_assets.length; k++) {
                var sa = it.supplementary_assets[k];
                try {
                  it.resources.push(await api('users/me/subscribed-courses/' + id + '/lectures/' + it.id +
                    '/supplementary-assets/' + sa.id + '/?' + RESOURCE_FIELDS, o));
                } catch (e) {
                  if (isFatal(e)) throw e;
                  it.resources.push(Object.assign({}, sa, { error: msg(e) }));
                  S.errors.push({ where: 'resource ' + sa.id + ' of lecture ' + it.id, error: msg(e) });
                }
              }
            }
            S.done += 1;
          } else if (it._class === 'quiz' && o.includeQuizzes) {
            it.assessments = await paged('quizzes/' + it.id + '/assessments/?version=1&page_size=250&' + QUIZ_FIELDS, o);
            S.done += 1;
          }
          consecutive = 0;
        } catch (e) {
          if (isFatal(e)) throw e;
          S.errors.push({ where: it._class + ' ' + it.id + ' "' + it.title + '"', error: msg(e) });
          if (it._class === 'lecture' || (it._class === 'quiz' && o.includeQuizzes)) S.done += 1;
          consecutive += 1;
          if (consecutive >= o.maxConsecutiveErrors) {
            throw new Error('stopped after ' + consecutive + ' consecutive errors; last: ' + msg(e));
          }
        }
      }
      var manifest = {
        tool: 'udemy_manifest.js', version: VERSION, generated_at: new Date().toISOString(),
        source_page: location.href, origin: location.origin, course_id: id, course: info,
        curriculum: items, errors: S.errors
      };
      S.summary = summarize(manifest);
      S.manifest = manifest;
      var slug = String(info.published_title || slugFrom(course)).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);
      S.file = 'udemy_manifest_' + id + '_' + slug + '.json';
      if (o.download) save(manifest, S.file);
      S.status = 'done';
    } catch (e) {
      S.status = 'error';
      S.error = msg(e);
    }
    return status();
  }

  W.udmRun = run;
  W.udmStart = function (course, opts) {
    if (S.status === 'running') return 'already running: ' + status();
    run(course, opts);
    return 'started; poll udmStatus()';
  };
  W.udmStatus = status;
  W.udmListCourses = listCourses;
  W.udmSaveAgain = function () {
    if (!S.manifest) return 'nothing to save yet';
    save(S.manifest, S.file);
    return 'download triggered again: ' + S.file;
  };
  return 'udemy_manifest.js ' + VERSION + ' loaded: udmListCourses(), udmStart(slugOrId), udmStatus(), udmSaveAgain()';
})();
