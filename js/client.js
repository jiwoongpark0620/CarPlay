/* CarPlay client for a stock Carlinkit T2C SE (branch 3075), hosted outside the adapter.
 *
 * Adapter WebSocket (protocol.js) -> H.264 access units -> FFmpeg/WebAssembly in a worker
 * (video.js + h264worker.js, from taylor224/cpc200-t2c). Every unit is decoded, only the newest
 * is drawn, so latency never builds up. In the car this firmware fixes the session at 960x756
 * whatever the page asks for, so there is no size handling here at all.
 *
 * Resolution / frame rate are adapter settings: set them once in the stock page's AutoKit menu
 * (tespush.com); this page never changes them.
 *
 * Options: ?log=1 event log overlay, ?stats=1 fps/bitrate/decode overlay.
 */
(function () {
  'use strict';

  var BUILD = 'b10';
  var ADAPTER = 'https://tespush.com/';
  var CMD = LinkClient.CMD, KEY = LinkClient.KEY;
  var params = new URLSearchParams(location.search);
  var LOG = params.get('log') === '1';
  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ log (?log=1 only) */

  var logLines = [];
  function logEvent(k, d) {
    if (!LOG) return;
    var t = new Date();
    logLines.push(('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + k + (d === undefined ? '' : ' ' + d));
    if (logLines.length > 30) logLines.shift();
    var el = $('log');
    if (!el) { el = document.createElement('pre'); el.id = 'log'; document.body.appendChild(el); }
    el.textContent = logLines.join('\n');
  }

  function msg(text) {
    var el = $('msg');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  /* ------------------------------------------------------------------- state */

  var link = new LinkClient();
  var presenter = null;
  var state = { init: false, link: -1, shown: false, rx: 0, videoAt: 0 };

  // The iPhone sends an IDR only when asked: at most one request a second, never dropped.
  var keyTimer = 0, keyPending = false;
  function requestKeyframe() {
    if (keyTimer) { keyPending = true; return; }
    keyPending = false;
    keyTimer = setTimeout(function () { keyTimer = 0; if (keyPending) requestKeyframe(); }, 1000);
    if (state.link > 1) link.cmd(CMD.KEYFRAME);
  }

  function isDark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  function setLink(n) {
    if (n === state.link) return;
    logEvent('link', state.link + '->' + n);
    var prev = state.link;
    state.link = n;
    if (n > 1) {
      link.cmd(CMD.VIDEO);
      presenter.startH264();
      state.rx = 0; state.shown = false; state.videoAt = Date.now();
      msg(presenter.workerReady ? '영상 기다리는 중…' : '디코더 불러오는 중…');
    } else {
      if (prev > 1) presenter.stop();
      presenter.clear();
      msg(n === 1 ? 'iPhone 연결됨\n화면을 누르면 CarPlay를 엽니다' : n === 0 ? 'iPhone 연결을 기다리는 중…' : '어댑터 연결 중…');
    }
  }

  function onInit(j) {
    logEvent('init', 'link ' + j.link + ' vid ' + j.vid + ' pixel ' + j.pixel + ' fps ' + j.fps + ' ' + (j.SW || ''));
    state.init = true;
    link.setNight(isDark());
    if (!j.vid) {
      // Picture (MJPEG) mode (the stock page may leave it there): switch to H.264. The mode is picked
      // when a session starts and a preset change is what restarts one, so step to another preset and
      // back again: the resolution chosen in the stock AutoKit settings is kept.
      var orig = j.pixel | 0, alt = orig === 3 ? 1 : 3;
      logEvent('mode', 'picture -> video (pixel ' + orig + ' kept)');
      link.setKey(KEY.MODE, 1);
      link.setKey(KEY.PIXEL, alt);
      setTimeout(function () { if (link.open) link.setKey(KEY.PIXEL, orig); }, 10000);
    }
    setLink(j.link);
    if (j.link === 1) link.cmd(CMD.VIDEO);
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
    stage.addEventListener('pointermove', function (e) { if (down && e.pointerId === pid) send(e, 2); });
    function up(e) {
      if (!down || e.pointerId !== pid) return;
      down = false; pid = -1;
      send(e, 1);
    }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ------------------------------------------------------- offline copy */

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;
    logEvent('sw', hadController ? 'offline copy' : 'not installed');
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      reg.update().catch(function () { /* offline */ });
      reg.addEventListener('updatefound', function () { logEvent('sw', 'update downloading'); });
    }, function (e) { logEvent('sw', 'register failed: ' + (e && e.message)); });
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    logEvent('boot', BUILD);
    registerSW();
    if (!VideoPresenter.canH264() || !VideoPresenter.wasmSimd()) {
      msg('이 브라우저에서는 H.264 디코딩을 할 수 없습니다');
      return;
    }
    presenter = new VideoPresenter({
      canvas: null, canvasWorker: $('cp-canvas-worker'), img: null, statsEl: $('stats'), fit: 'contain',
      onMessage: function (kind, a, b) {
        if (kind === 'needkey') { requestKeyframe(); if (!state.shown) msg('키프레임 기다리는 중…'); }
        else if (kind === 'refresh') requestKeyframe();
        else if (kind === 'ready') { if (state.link > 1) { msg('영상 기다리는 중…'); requestKeyframe(); } }
        else if (kind === 'key') { state.shown = true; if (state.link > 1) msg(null); }
        else if (kind === 'size') logEvent('size', a + 'x' + b);
        else if (kind === 'loading') msg('디코더 불러오는 중… (' + a + ')');
        else if (kind === 'slow') logEvent('slow');
        else if (kind === 'h264error') {
          logEvent('h264error', a);
          msg('디코더 오류: ' + a + (b ? '\n잠시 후 다시 시도합니다' : ''));
          if (b) setTimeout(function () { if (state.link > 1) presenter.startH264(); }, 5000);
        }
      }
    });
    presenter.setStatsVisible(params.get('stats') === '1');
    bindTouch();

    // A socket that keeps dropping (seen right after the adapter switches modes) settles after a
    // page reload: do that once, at most once a minute.
    var closes = [];
    function flapCheck() {
      var t = Date.now();
      closes.push(t);
      closes = closes.filter(function (c) { return t - c < 20000; });
      if (closes.length < 4) return;
      var last = 0;
      try { last = +sessionStorage.getItem('cp.flap') || 0; sessionStorage.setItem('cp.flap', String(t)); } catch (e) { /* ignore */ }
      if (t - last >= 60000) location.reload();
    }

    link.on('init', onInit)
      .on('link', function (j) { if (state.init) setLink(j.link); })
      .on('video', function (bytes) { if (state.link > 1) { state.rx++; presenter.feedH264(bytes); } })
      .on('videodrop', function () { presenter.noteDrop(); })
      .on('superseded', function () { logEvent('superseded'); setLink(-1); msg('다른 화면이 어댑터를 사용 중입니다\n화면을 누르면 다시 연결합니다'); })
      .on('close', function (code) { logEvent('close', code); state.init = false; setLink(-1); flapCheck(); })
      .on('open', function () { logEvent('open'); msg('어댑터 연결됨'); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { presenter.pause(); return; }
      if (!link.open) { link.connect(); return; }
      if (state.link > 1) { presenter.resume(); requestKeyframe(); }
    });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (link.open) link.setNight(isDark()); }); } catch (e) { /* ignore */ }

    // Black screen for a while: say why.
    setInterval(function () {
      if (state.link <= 1 || state.shown || !presenter.workerReady || Date.now() - state.videoAt < 6000) return;
      if (state.rx === 0) msg('어댑터가 영상을 보내지 않습니다\n다른 탭/기기에서 tespush.com 이 열려 있으면 닫으세요');
      else requestKeyframe();
    }, 2000);

    // Warm up DNS + TLS with a plain request first (the first WebSocket alone often timed out).
    var u = navigator.userAgent, i = u.indexOf('Tesla');
    var hello = { w: window.innerWidth, h: window.innerHeight, lang: navigator.language, nav: i >= 0 ? u.substring(i) : 'null' };
    var started = false;
    function start() { if (!started) { started = true; link.connect(hello); } }
    msg('어댑터 찾는 중…');
    fetch(ADAPTER + '?warm=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).then(start, start);
    setTimeout(start, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
