/* Minimal CarPlay client for a stock Carlinkit T2C, hosted outside the adapter.
 *
 * Talks to the adapter's own WebSocket (protocol.js), puts it in H.264 mode and decodes
 * in a worker with FFmpeg/WebAssembly (video.js + h264worker.js, from taylor224/cpc200-t2c).
 * The point is flow control: every access unit is decoded, only the newest is drawn, so a
 * slow moment costs a skipped picture instead of latency that keeps growing.
 *
 * URL options:
 *   ?size=1280x800   CarPlay session size (session override, type 11). Default 1280x800.
 *   ?size=auto       let the adapter derive the size from the page (800 x 800*h/w).
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
  var sizeParam = params.get('size');
  // A size the adapter did not honour once is remembered; ?size=... in the URL tries again.
  if (sizeParam) store.set('auto', null);
  var SIZE = sizeParam === 'auto' || (!sizeParam && store.get('auto') === '1') ? null
           : (parseSize(sizeParam) || { w: 1280, h: 800 });

  /* ------------------------------------------------------------------- state */

  var state = { init: false, link: -1, pixel: 3, vid: false, restartAt: 0, restarts: 0, restartTimer: 0, sizeChecked: false, sizeTries: 0 };
  var link = new LinkClient();
  var presenter = null;

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
    if (n > 1) {
      link.cmd(CMD.VIDEO);
      presenter.startH264();
      msg(null);
    } else {
      if (prev > 1) presenter.stop();
      presenter.clear();
      if (n === 1) msg('iPhone 연결됨\n화면을 누르면 CarPlay를 엽니다');
      else if (n === 0) msg('iPhone 연결을 기다리는 중…');
      else msg('어댑터 연결 중…');
    }
  }

  function onInit(j) {
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
    if (!VideoPresenter.canH264() || !VideoPresenter.wasmSimd()) {
      msg('이 브라우저에서는 H.264 디코딩을 할 수 없습니다\n(WebAssembly SIMD / OffscreenCanvas 필요)');
      return;
    }
    presenter = new VideoPresenter({
      canvas: $('cp-canvas'), canvasWorker: $('cp-canvas-worker'), img: null, statsEl: $('stats'), fit: 'contain',
      onMessage: function (kind, a, b) {
        if (kind === 'size') onSize(a, b);
        else if (kind === 'needkey' || kind === 'refresh') requestKeyframe();
        else if (kind === 'ready') { if (state.link > 1) { msg(null); requestKeyframe(); } }
        else if (kind === 'key') { if (state.link > 1) msg(null); }
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
      .on('video', function (bytes) { if (state.link > 1) presenter.feedH264(bytes); })
      .on('videodrop', function () { presenter.noteDrop(); })
      .on('superseded', function () { setLink(-1); msg('다른 화면이 어댑터를 사용 중입니다\n화면을 누르면 다시 연결합니다'); })
      .on('close', function () { state.init = false; setLink(-1); })
      .on('open', function () { msg('어댑터 연결됨'); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { presenter.pause(); return; }
      if (!link.open) { link.connect(); return; }
      if (state.link > 1) { presenter.resume(); requestKeyframe(); }
    });
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (link.open) link.setNight(isDark()); });
    } catch (e) { /* ignore */ }

    link.connect({ w: window.innerWidth, h: window.innerHeight, lang: navigator.language, nav: getTesla() });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
