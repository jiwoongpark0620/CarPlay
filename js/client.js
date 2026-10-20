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
 * Two transports:
 *   video   (default) H.264 over the WebSocket, decoded here. No latency build-up, but stock
 *           firmware writes each frame in 8 KB pieces, so frames arrive in clumps.
 *   picture ?mode=picture: the adapter's own hardware turns the stream into JPEGs served at
 *           /video.jpg (what the stock page shows in the car). Lower base latency; the stream is
 *           re-opened every ?refresh= seconds (default 15) so a backlog cannot build up. The
 *           browser keeps the old picture on screen until the new stream's first frame is in.
 *
 * Options: ?log=1 event log overlay, ?stats=1 fps/bitrate/decode overlay (video).
 */
(function () {
  'use strict';

  var BUILD = 'b13';
  var ADAPTER = 'https://tespush.com/';
  var CMD = LinkClient.CMD, KEY = LinkClient.KEY;
  var params = new URLSearchParams(location.search);
  var LOG = params.get('log') === '1';
  var PICTURE = params.get('mode') === 'picture';
  var REFRESH = Math.max(5, parseFloat(params.get('refresh')) || 15) * 1000;
  // Picture mode: the adapter's JPEG need not have the session's shape (it can squeeze the 960x756
  // session into its own picture size), so by default it is stretched over the whole stage, like the
  // stock page does. ?fit=contain keeps the JPEG's own aspect instead.
  var PIC_FILL = params.get('fit') !== 'contain';
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

  /* -------------------------------------------------------- picture (MJPEG) */

  var pic = {
    img: null, timer: 0, on: false, loaded: false, sized: false,
    start: function () {
      this.on = true; this.loaded = false;
      this.img.classList.remove('hidden');
      this.open();
      clearInterval(this.timer);
      this.timer = setInterval(function () { pic.open(); }, REFRESH);
    },
    // A new URL each time: the browser opens a new stream and swaps over on its first frame, so the
    // picture does not blank. If the adapter serves only one stream at a time the new one never
    // starts while the old is open: then close the old one first (a short blank) from then on.
    hard: false, waiting: false, wd: 0,
    open: function () {
      if (!this.on) return;
      var url = ADAPTER + 'video.jpg?t=' + Date.now(), img = this.img;
      this.waiting = true;
      clearTimeout(this.wd);
      if (this.hard) {
        img.removeAttribute('src');
        setTimeout(function () { if (pic.on) img.src = url; }, 50);
        return;
      }
      img.src = url;
      this.wd = setTimeout(function () {
        if (!pic.on || !pic.waiting) return;
        logEvent('picture', 'stream swap stalled: close-then-open from now on');
        pic.hard = true;
        pic.open();
      }, 4000);
    },
    stop: function () {
      this.on = false; clearInterval(this.timer); this.timer = 0;
      this.img.removeAttribute('src');
    },
    toPerMille: function (cx, cy) {
      var r = this.img.getBoundingClientRect(), fw = this.img.naturalWidth, fh = this.img.naturalHeight;
      if (r.width <= 0 || r.height <= 0 || !fw || !fh) return null;
      var k = Math.min(r.width / fw, r.height / fh), dw = PIC_FILL ? r.width : fw * k, dh = PIC_FILL ? r.height : fh * k;
      var x = (cx - r.left - (r.width - dw) / 2) * 1000 / dw, y = (cy - r.top - (r.height - dh) / 2) * 1000 / dh;
      return { x: Math.round(Math.max(0, Math.min(1000, x))), y: Math.round(Math.max(0, Math.min(1000, y))) };
    }
  };

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
      state.rx = 0; state.shown = false; state.videoAt = Date.now();
      if (PICTURE) { pic.start(); msg('영상 기다리는 중…'); }
      else {
        presenter.startH264();
        msg(presenter.workerReady ? '영상 기다리는 중…' : '디코더 불러오는 중…');
      }
    } else {
      if (PICTURE) pic.stop();
      else { if (prev > 1) presenter.stop(); presenter.clear(); }
      msg(n === 1 ? 'iPhone 연결됨\n화면을 누르면 CarPlay를 엽니다' : n === 0 ? 'iPhone 연결을 기다리는 중…' : '어댑터 연결 중…');
    }
  }

  function onInit(j) {
    logEvent('init', 'link ' + j.link + ' vid ' + j.vid + ' pixel ' + j.pixel + ' fps ' + j.fps + ' ' + (j.SW || ''));
    state.init = true;
    link.setNight(isDark());
    if (!!j.vid === PICTURE) {
      // The adapter is in the other transport. The mode is picked when a session starts and a preset
      // change is what restarts one, so step to another preset and back again: the resolution chosen
      // in the stock AutoKit settings is kept.
      var orig = j.pixel | 0, alt = orig === 3 ? 1 : 3;
      logEvent('mode', (PICTURE ? 'video -> picture' : 'picture -> video') + ' (pixel ' + orig + ' kept)');
      link.setKey(KEY.MODE, PICTURE ? 0 : 1);
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
      var p = PICTURE ? pic.toPerMille(e.clientX, e.clientY) : presenter.toPerMille(e.clientX, e.clientY);
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
    pic.img = $('cp-img');
    pic.img.style.objectFit = PIC_FILL ? 'fill' : 'contain';
    pic.img.addEventListener('load', function () {
      pic.waiting = false;
      if (!pic.loaded) { pic.loaded = true; state.shown = true; if (state.link > 1) msg(null); }
      if (!pic.sized && pic.img.naturalWidth) { pic.sized = true; logEvent('size', pic.img.naturalWidth + 'x' + pic.img.naturalHeight + ' picture'); }
    });
    pic.img.addEventListener('error', function () { logEvent('picture', 'stream error'); if (pic.on) setTimeout(function () { pic.open(); }, 1000); });
    if (PICTURE) $('cp-canvas-worker').classList.add('hidden');
    if (!PICTURE && (!VideoPresenter.canH264() || !VideoPresenter.wasmSimd())) {
      msg('이 브라우저에서는 H.264 디코딩을 할 수 없습니다\n?mode=picture 로 열어 보세요');
      return;
    }
    if (!PICTURE) presenter = new VideoPresenter({
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
    if (presenter) presenter.setStatsVisible(params.get('stats') === '1');
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
      .on('video', function (bytes) { if (state.link > 1 && presenter) { state.rx++; presenter.feedH264(bytes); } })
      .on('videodrop', function () { if (presenter) presenter.noteDrop(); })
      .on('superseded', function () { logEvent('superseded'); setLink(-1); msg('다른 화면이 어댑터를 사용 중입니다\n화면을 누르면 다시 연결합니다'); })
      .on('close', function (code) { logEvent('close', code); state.init = false; setLink(-1); flapCheck(); })
      .on('open', function () { logEvent('open'); msg('어댑터 연결됨'); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (PICTURE) pic.stop(); else presenter.pause(); return; }
      if (!link.open) { link.connect(); return; }
      if (state.link > 1) { if (PICTURE) pic.start(); else { presenter.resume(); requestKeyframe(); } }
    });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (link.open) link.setNight(isDark()); }); } catch (e) { /* ignore */ }

    // Black screen for a while: say why.
    setInterval(function () {
      if (state.link <= 1 || state.shown || Date.now() - state.videoAt < 6000) return;
      if (PICTURE) { msg('사진 모드 영상이 오지 않습니다\n모드 전환 중이면 20초쯤 기다려 주세요'); pic.open(); return; }
      if (!presenter.workerReady) return;
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
