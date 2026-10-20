/* CarPlay page for a stock Carlinkit T2C SE in a Tesla browser.
 *
 * The adapter's own hardware turns the CarPlay stream into JPEGs served as one long
 * multipart response (/video.jpg); this page shows it in an <img>, sends touches over the
 * adapter's WebSocket (link.js), and re-opens the picture stream every few seconds so the
 * backlog that builds up on the stock page never does. The browser keeps the old picture
 * on screen until the new stream's first frame is in.
 *
 * Options: ?refresh=15 (seconds between stream re-opens), ?fit=contain (keep the JPEG's own
 * aspect instead of filling the screen), ?log=1 (event log).
 */
(function () {
  'use strict';

  var BUILD = 'p1';
  var ADAPTER = 'https://tespush.com/';
  var params = new URLSearchParams(location.search);
  var REFRESH = Math.max(5, parseFloat(params.get('refresh')) || 15) * 1000;
  var FILL = params.get('fit') !== 'contain';
  var LOG = params.get('log') === '1';
  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- log */

  var lines = [];
  function log(k, d) {
    if (!LOG) return;
    var t = new Date();
    lines.push(('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + ' ' + k + (d === undefined ? '' : ' ' + d));
    if (lines.length > 30) lines.shift();
    var el = $('log');
    if (!el) { el = document.createElement('pre'); el.id = 'log'; document.body.appendChild(el); }
    el.textContent = lines.join('\n');
  }

  function msg(text) {
    var el = $('msg');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  /* ------------------------------------------------------------ picture */

  var img = $('picture');
  var pic = {
    on: false, shown: false, sized: false, waiting: false, closeFirst: false, timer: 0, watchdog: 0, startedAt: 0,

    start: function () {
      this.on = true; this.shown = false; this.startedAt = Date.now();
      img.classList.remove('hidden');
      this.open();
      clearInterval(this.timer);
      this.timer = setInterval(function () { pic.open(); }, REFRESH);
    },

    /* A fresh URL opens a new stream. If the adapter serves only one stream at a time, the new
     * one cannot start while the old is open: then close first (a short blank) from then on. */
    open: function () {
      if (!this.on) return;
      var url = ADAPTER + 'video.jpg?t=' + Date.now();
      this.waiting = true;
      clearTimeout(this.watchdog);
      if (this.closeFirst) {
        img.removeAttribute('src');
        setTimeout(function () { if (pic.on) img.src = url; }, 50);
        return;
      }
      img.src = url;
      this.watchdog = setTimeout(function () {
        if (!pic.on || !pic.waiting) return;
        log('picture', 'stream swap stalled: close first from now on');
        pic.closeFirst = true;
        pic.open();
      }, 4000);
    },

    stop: function () {
      this.on = false;
      clearInterval(this.timer); clearTimeout(this.watchdog);
      img.removeAttribute('src');
    },

    /* Screen point -> 0..1000 of the picture. */
    point: function (cx, cy) {
      var r = img.getBoundingClientRect(), fw = img.naturalWidth, fh = img.naturalHeight;
      if (r.width <= 0 || r.height <= 0 || !fw || !fh) return null;
      var k = Math.min(r.width / fw, r.height / fh);
      var dw = FILL ? r.width : fw * k, dh = FILL ? r.height : fh * k;
      var x = (cx - r.left - (r.width - dw) / 2) * 1000 / dw;
      var y = (cy - r.top - (r.height - dh) / 2) * 1000 / dh;
      return { x: Math.round(Math.max(0, Math.min(1000, x))), y: Math.round(Math.max(0, Math.min(1000, y))) };
    }
  };

  img.style.objectFit = FILL ? 'fill' : 'contain';
  img.addEventListener('load', function () {
    pic.waiting = false;
    if (!pic.shown) { pic.shown = true; if (state.link > 1) msg(null); }
    if (!pic.sized && img.naturalWidth) { pic.sized = true; log('size', img.naturalWidth + 'x' + img.naturalHeight); }
  });
  img.addEventListener('error', function () {
    log('picture', 'stream error');
    if (pic.on) setTimeout(function () { pic.open(); }, 1000);
  });

  /* ------------------------------------------------------------ adapter */

  var link = new Link();
  var state = { init: false, link: -1 };

  function setLink(n) {
    if (n === state.link) return;
    log('link', state.link + '->' + n);
    state.link = n;
    if (n > 1) {
      link.command(Link.CMD_START);
      pic.start();
      msg('영상 기다리는 중…');
    } else {
      pic.stop();
      msg(n === 1 ? 'iPhone 연결됨\n화면을 누르면 CarPlay를 엽니다' : n === 0 ? 'iPhone 연결을 기다리는 중…' : '어댑터 연결 중…');
    }
  }

  function dark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  link.on('open', function () { log('open'); msg('어댑터 연결됨'); })
    .on('init', function (j) {
      log('init', 'link ' + j.link + ' vid ' + j.vid + ' pixel ' + j.pixel + ' ' + (j.SW || ''));
      state.init = true;
      link.night(dark());
      if (j.vid) {
        // The adapter sends H.264 over the socket instead of JPEGs: switch it to pictures. The mode
        // is taken when a session starts and a resolution change is what starts one, so step to
        // another preset and back: the resolution chosen in the AutoKit settings is kept.
        var orig = j.pixel | 0, other = orig === 3 ? 1 : 3;
        log('mode', 'video -> picture (resolution ' + orig + ' kept)');
        link.setting(Link.KEY_MODE, 0);
        link.setting(Link.KEY_PIXEL, other);
        setTimeout(function () { if (link.open) link.setting(Link.KEY_PIXEL, orig); }, 10000);
      }
      setLink(j.link);
      if (j.link === 1) link.command(Link.CMD_START);
    })
    .on('link', function (j) { if (state.init) setLink(j.link); })
    .on('superseded', function () {
      log('superseded'); state.init = false; setLink(-1);
      msg('다른 화면이 어댑터를 사용 중입니다\n화면을 누르면 다시 연결합니다');
    })
    .on('close', function (code) { log('close', code); state.init = false; setLink(-1); flapCheck(); });

  // A socket that keeps dropping (seen right after the adapter switches modes) settles after a page
  // reload: do that, at most once a minute.
  var closes = [];
  function flapCheck() {
    var t = Date.now();
    closes = closes.filter(function (c) { return t - c < 20000; });
    closes.push(t);
    if (closes.length < 4) return;
    var last = 0;
    try { last = +sessionStorage.getItem('cp.flap') || 0; sessionStorage.setItem('cp.flap', String(t)); } catch (e) { /* ignore */ }
    if (t - last >= 60000) location.reload();
  }

  /* -------------------------------------------------------------- touch */

  (function () {
    var stage = $('stage'), down = false, id = -1;
    function send(e, action) {
      var p = pic.point(e.clientX, e.clientY);
      if (p) link.touch(action, p.x, p.y);
    }
    stage.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (!link.open) { link.connect(); return; }
      if (state.link === 1) { link.command(Link.CMD_START); return; }
      if (state.link < 2 || down) return;
      down = true; id = e.pointerId;
      try { stage.setPointerCapture(id); } catch (err) { /* ignore */ }
      send(e, 0);
    });
    stage.addEventListener('pointermove', function (e) { if (down && e.pointerId === id) send(e, 2); });
    function up(e) {
      if (!down || e.pointerId !== id) return;
      down = false; id = -1;
      send(e, 1);
    }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  })();

  /* -------------------------------------------------------- page state */

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { pic.stop(); return; }
    if (!link.open) { link.connect(); return; }
    if (state.link > 1) pic.start();
  });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { link.night(dark()); }); } catch (e) { /* ignore */ }

  setInterval(function () {
    if (state.link > 1 && pic.on && !pic.shown && Date.now() - pic.startedAt > 6000) {
      msg('영상이 오지 않습니다\n모드 전환 중이면 20초쯤 기다려 주세요');
      pic.open();
    }
  }, 3000);

  /* -------------------------------------------------------- offline copy */

  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    log('sw', hadController ? 'offline copy' : 'not installed');
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (!hadController) navigator.serviceWorker.ready.then(function () { log('sw', 'installed'); });
      reg.update().catch(function () { /* offline */ });
    }, function (e) { log('sw', 'register failed: ' + (e && e.message)); });
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController && !reloading) { reloading = true; location.reload(); }
    });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- start */

  log('boot', BUILD);
  var ua = navigator.userAgent, at = ua.indexOf('Tesla');
  var hello = { w: innerWidth, h: innerHeight, lang: navigator.language, nav: at >= 0 ? ua.substring(at) : 'null' };
  var started = false;
  function start() { if (!started) { started = true; link.connect(hello); } }
  msg('어댑터 찾는 중…');
  // Warm up DNS and TLS with a plain request first: the first WebSocket alone often timed out.
  fetch(ADAPTER + '?warm=' + Date.now(), { mode: 'no-cors', cache: 'no-store' }).then(start, start);
  setTimeout(start, 20000);
})();
