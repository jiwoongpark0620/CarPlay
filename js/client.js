/* Minimal CarPlay client for a stock Carlinkit T2C, hosted outside the adapter.
 *
 * Talks to the adapter's own WebSocket (protocol.js), puts it in H.264 mode and decodes
 * in a worker with FFmpeg/WebAssembly (video.js + h264worker.js, from taylor224/cpc200-t2c).
 * The point is flow control: every access unit is decoded, only the newest is drawn, so a
 * slow moment costs a skipped picture instead of latency that keeps growing.
 *
 * URL options:
 *   (default)        Auto: the adapter sizes the CarPlay session from the hello (page size).
 *                    Firmware 3075 (26081415.5.1.5) uses the hello size as is and ignores the
 *                    type-11 override, so this is the mode that works there.
 *   ?hidpi=1         send the page size x devicePixelRatio in the hello (sharper, more pixels).
 *   ?scale=1.25      same with an explicit factor.
 *   ?size=1280x800   try the session override instead (works on branch 1508, not on 3075).
 *   ?stats=1         fps / bitrate / decode time overlay.
 *   ?ws=...          adapter WebSocket URL (default wss://tespush.com/).
 */
(function () {
  'use strict';

  var CMD = LinkClient.CMD, KEY = LinkClient.KEY;
  function $(id) { return document.getElementById(id); }

  var params = new URLSearchParams(location.search);
  var store = {
    get: function (k) { try { return localStorage.getItem('cp.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v === null) localStorage.removeItem('cp.' + k); else localStorage.setItem('cp.' + k, v); } catch (e) { /* ignore */ } }
  };

  /* ------------------------------------------------------------ session size */

  function parseSize(s) {
    var m = /^(\d{3,4})x(\d{3,4})$/.exec(s || '');
    if (!m) return null;
    var w = (+m[1]) & ~15, h = (+m[2]) & ~15;          // 16-aligned
    if (w < 320 || h < 240 || w * h > 1376 * 1072) return null;
    return { w: w, h: h };
  }
  var SIZE = parseSize(params.get('size'));     // null = Auto (default)
  var SCALE = params.get('hidpi') === '1' ? (window.devicePixelRatio || 1) : (parseFloat(params.get('scale')) || 1);
  SCALE = Math.max(0.5, Math.min(2, SCALE));
  function helloSize() {
    var w = Math.round(window.innerWidth * SCALE), h = Math.round(window.innerHeight * SCALE);
    var k = Math.min(1, 2400 / w, 2400 / h);        // hello stores w/10, h/10 in a byte each
    return { w: Math.round(w * k), h: Math.round(h * k) };
  }

  /* ------------------------------------------------------------------- state */

  var state = { init: false, link: -1, pixel: 3, vid: false, restartAt: 0, restarts: 0, restartTimer: 0, sizeChecked: false, sizeTries: 0, rx: 0, shown: false, videoAt: 0 };
  var link = new LinkClient();
  var presenter = null;

  /* Event log (last 80, kept across reloads): shown with ?log=1, so a problem can be read back. */
  var LOG_MAX = 80;
  function logEvent(k, d) {
    var list = [];
    try { list = JSON.parse(store.get('log') || '[]'); } catch (e) { /* ignore */ }
    list.push([Date.now(), k, d === undefined ? '' : String(d)]);
    if (list.length > LOG_MAX) list = list.slice(-LOG_MAX);
    store.set('log', JSON.stringify(list));
    if (params.get('log') === '1') renderLog(list);
  }
  function renderLog(list) {
    var el = document.getElementById('log');
    if (!el) { el = document.createElement('pre'); el.id = 'log'; document.body.appendChild(el); }
    el.textContent = list.slice(-25).map(function (e) {
      var t = new Date(e[0]);
      return ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + '.' + ('00' + t.getMilliseconds()).slice(-3) + ' ' + e[1] + ' ' + e[2];
    }).join('\n');
  }

  function msg(text) {
    var el = $('msg');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  function getTesla() {
    var u = navigator.userAgent, i = u.indexOf('Tesla');
    return i >= 0 ? u.substring(i) : 'null';
  }

  function isDark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  // The iPhone sends an IDR only when asked: at most one request a second, never dropped.
  var keyTimer = 0, keyPending = false;
  function requestKeyframe() {
    if (keyTimer) { keyPending = true; return; }
    keyPending = false;
    keyTimer = setTimeout(function () { keyTimer = 0; if (keyPending) requestKeyframe(); }, 1000);
    if (state.link > 1) link.cmd(CMD.KEYFRAME);
  }

  /* A CarPlay session restart makes the iPhone reconnect (a few seconds) — keep them rare:
   * at least 10 s apart and at most 3 automatic ones per page load. */
  function restartSession(why) {
    if (state.restartTimer) return;
    var wait = 10000 - (Date.now() - state.restartAt);
    if (wait > 0) { state.restartTimer = setTimeout(function () { state.restartTimer = 0; restartSession(why); }, wait); return; }
    if (state.restarts >= 3) { msg('화면 설정이 적용되지 않습니다 (' + why + ').\n어댑터를 재연결한 뒤 다시 열어 주세요.'); return; }
    state.restartAt = Date.now(); state.restarts++;
    logEvent('restart', why + ' (#' + state.restarts + ', pixel ' + state.pixel + ', size ' + (SIZE ? SIZE.w + 'x' + SIZE.h : 'auto') + ')');
    state.sizeChecked = false;
    msg('CarPlay 세션 다시 시작 중…');
    if (SIZE) {
      // Any pixel-preset change restarts the session; the override then replaces the preset size.
      state.pixel = state.pixel === 0 ? 1 : 0;
      link.setKey(KEY.PIXEL, state.pixel);
    } else if (state.pixel !== 3) {
      state.pixel = 3;
      link.setKey(KEY.PIXEL, 3);
    } else {
      link.drop();          // reconnect in 1 s; in Auto every hello restarts the session with the page size
    }
  }

  function sendOverride() {
    if (SIZE) link.setSessionOverride(SIZE.w, SIZE.h, Math.round(SIZE.w / 5.2), Math.round(SIZE.h / 5.2));
    else link.setSessionOverride(0, 0, 0, 0);
  }

  /* ----------------------------------------------------------------- link */

  function setLink(n) {
    if (n === state.link) return;
    var prev = state.link;
    state.link = n;
    logEvent('link', prev + '->' + n);
    if (n > 1) {
      link.cmd(CMD.VIDEO);
      presenter.startH264();
      state.rx = 0; state.shown = false; state.videoAt = Date.now();
      msg(presenter.workerReady ? '영상 기다리는 중…' : '디코더 불러오는 중…\n(처음 한 번 1.4 MB, 느린 인터넷에서는 30초 이상)');
    } else {
      if (prev > 1) presenter.stop();
      presenter.clear();
      if (n === 1) msg('iPhone 연결됨\n화면을 누르면 CarPlay를 엽니다');
      else if (n === 0) msg('iPhone 연결을 기다리는 중…');
      else msg('어댑터 연결 중…');
    }
  }

  function onInit(j) {
    logEvent('init', 'link ' + j.link + ' phone ' + j.phone + ' vid ' + j.vid + ' pixel ' + j.pixel + ' ' + (j.SW || ''));
    state.init = true;
    state.pixel = j.pixel;
    sendOverride();
    link.setNight(isDark());
    var needRestart = false;
    if (!j.vid) {                       // picture (MJPEG) mode: switch to H.264
      link.setKey(KEY.MODE, 1);
      needRestart = true;
    }
    state.vid = true;
    setLink(j.link);
    if (j.link === 1) link.cmd(CMD.VIDEO);
    if (needRestart && j.link >= 1) restartSession('mode');
  }

  /* The decoder reports the size of the stream it gets: check that the session is what we asked for. */
  function onSize(w, h) {
    logEvent('size', w + 'x' + h);
    if (state.sizeChecked) return;
    state.sizeChecked = true;
    if (!SIZE) return;
    if (Math.abs(w - SIZE.w) <= 16 && Math.abs(h - SIZE.h) <= 16) return;
    if (state.sizeTries++ === 0) { restartSession('size ' + w + 'x' + h); return; }
    // Still the wrong size after a restart: this firmware ignores the override. Use Auto from now on.
    store.set('auto', '1');
    SIZE = null;
    sendOverride();
    restartSession('auto');
  }

  /* ---------------------------------------------------------------- touch */

  function bindTouch() {
    var stage = $('stage'), down = false, pid = -1;
    function send(e, m) {
      var p = presenter.toPerMille(e.clientX, e.clientY);
      if (p) link.sendTouch(m, p.x, p.y);
    }
    stage.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (!link.open) { link.connect(); return; }
      if (state.link === 1) { link.cmd(CMD.VIDEO); return; }
      if (state.link < 2 || down) return;
      down = true; pid = e.pointerId;
      try { stage.setPointerCapture(pid); } catch (err) { /* ignore */ }
      send(e, 0);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!down || e.pointerId !== pid) return;
      send(e, 2);
    });
    function up(e) {
      if (!down || e.pointerId !== pid) return;
      down = false; pid = -1;
      send(e, 1);
    }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    logEvent('boot', location.search || '-');
    if (params.get('log') === '1') { try { renderLog(JSON.parse(store.get('log') || '[]')); } catch (e) { /* ignore */ } }
    if (!VideoPresenter.canH264() || !VideoPresenter.wasmSimd()) {
      msg('이 브라우저에서는 H.264 디코딩을 할 수 없습니다\n(WebAssembly SIMD / OffscreenCanvas 필요)');
      return;
    }
    presenter = new VideoPresenter({
      canvas: $('cp-canvas'), canvasWorker: $('cp-canvas-worker'), img: null, statsEl: $('stats'), fit: 'contain',
      onMessage: function (kind, a, b) {
        if (kind === 'size') onSize(a, b);
        else if (kind === 'needkey') { requestKeyframe(); if (!state.shown) msg('키프레임 기다리는 중… (수신 ' + state.rx + ')'); }
        else if (kind === 'refresh') requestKeyframe();
        else if (kind === 'ready') { if (state.link > 1) { msg('영상 기다리는 중…'); requestKeyframe(); } }
        else if (kind === 'key') { state.shown = true; if (state.link > 1) msg(null); }
        else if (kind === 'loading') msg('디코더 내려받는 중… (' + a + ')');
        else if (kind === 'slow') msg('디코딩이 영상 속도를 따라가지 못합니다.\n?size=auto 로 해상도를 낮춰 보세요.');
        else if (kind === 'h264error') {
          msg('디코더 오류: ' + a + (b ? '\n잠시 후 다시 시도합니다' : ''));
          if (b) setTimeout(function () { if (state.link > 1) presenter.startH264(); }, 5000);
        }
      }
    });
    presenter.setStatsVisible(params.get('stats') === '1');
    bindTouch();

    link.on('init', onInit)
      .on('link', function (j) { if (state.init) setLink(j.link); })
      .on('video', function (bytes) { if (state.link > 1) { state.rx++; presenter.feedH264(bytes); } })
      .on('videodrop', function () { presenter.noteDrop(); })
      .on('superseded', function () { setLink(-1); msg('다른 화면이 어댑터를 사용 중입니다\n화면을 누르면 다시 연결합니다'); })
      .on('close', function (code) { logEvent('close', code === undefined ? 'dropped' : code); state.init = false; setLink(-1); flapCheck(); })
      .on('pingtimeout', function () { logEvent('pingtimeout'); })
      .on('reload', function () { logEvent('reload-msg'); })
      .on('superseded', function () { logEvent('superseded'); })
      .on('open', function () { logEvent('open'); msg('어댑터 연결됨'); });

    /* The socket keeps dropping and coming back (seen right after the first start: picture -> video
     * switch and session restarts). A page reload has always settled it, so do that once, not more
     * often than once a minute. */
    var closes = [];
    function flapCheck() {
      var t = Date.now();
      closes.push(t);
      closes = closes.filter(function (c) { return t - c < 20000; });
      if (closes.length < 4) return;
      var last = 0;
      try { last = +sessionStorage.getItem('cp.flapReload') || 0; } catch (e) { /* ignore */ }
      if (t - last < 60000) return;
      try { sessionStorage.setItem('cp.flapReload', String(t)); } catch (e) { /* ignore */ }
      logEvent('flap-reload', closes.length + ' closes in 20 s');
      location.reload();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { presenter.pause(); return; }
      if (!link.open) { link.connect(); return; }
      if (state.link > 1) { presenter.resume(); requestKeyframe(); }
    });
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (link.open) link.setNight(isDark()); });
    } catch (e) { /* ignore */ }

    // Nothing on screen for a while: say why instead of leaving a black page.
    setInterval(function () {
      if (state.link <= 1 || state.shown || !presenter.workerReady) return;
      if (Date.now() - state.videoAt < 6000) return;
      if (state.rx === 0) msg('어댑터가 영상을 보내지 않습니다.\n다른 탭/기기에서 tespush.com 이 열려 있으면 닫고 새로고침하세요.');
      else { msg('영상은 오는데 디코딩된 화면이 없습니다 (수신 ' + state.rx + ')\n?stats=1 로 열어 확인해 주세요.'); requestKeyframe(); }
    }, 2000);

    // Warm up DNS and TLS with a plain request first (a top-level visit to tespush.com did the same
    // by hand): an opaque no-cors answer is enough, failure or a slow answer just moves on.
    var hs = helloSize();
    var hello = { w: hs.w, h: hs.h, lang: navigator.language, nav: getTesla() };
    logEvent('hello', hs.w + 'x' + hs.h + (SCALE !== 1 ? ' (x' + SCALE.toFixed(2) + ')' : ''));
    var started = false;
    function start() { if (started) return; started = true; link.connect(hello); }
    msg('어댑터 찾는 중…');
    var adapterHttp = (params.get('ws') || 'wss://tespush.com/').replace(/^ws/, 'http');
    try {
      fetch(adapterHttp + '?warm=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).then(start, start);
    } catch (e) { start(); }
    setTimeout(start, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
