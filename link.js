/* Adapter link: the WebSocket ("tsl" sub-protocol) of a Carlinkit T2C / T2C SE.
 *
 * Messages are little endian.
 *   page -> adapter: Int16 length (payload bytes), Int16 type, payload
 *     1  touch    Int16 action (0 down, 1 up, 2 move), x, y   (0..1000 of the picture)
 *     2  hello    Int16 width, height, then language NUL, browser NUL
 *     3  command  Int16 command                                (0 = start CarPlay picture)
 *     7  setting  Int16 key, value                             (2 = resolution preset, 11 = mode)
 *     8  night    Int16 0 day / 1 night
 *     12 ping     Uint32 counter
 *   adapter -> page: Uint32 length, Uint32 type, payload
 *     0 status JSON (has "pong")   1 init JSON   3 link JSON   4 firmware JSON (has "pong")
 *     everything else is ignored here.
 *
 * The adapter answers one page at a time: the one that connected last.
 */
(function (global) {
  'use strict';

  var URL_WS = 'wss://tespush.com/';
  var URL_HTTP = 'https://tespush.com/';
  var OPEN_TIMEOUT = 15000;   // first connect also resolves tespush.com and does a slow TLS handshake
  var PONG_LATE = 6;          // pings without an answer before the link is checked

  function Link() {
    this.ws = null;
    this.open = false;
    this.hello = { w: 0, h: 0, lang: 'en', nav: 'null' };
    this.listeners = {};
    this.ping = 0;
    this.pong = 0;
    this.checking = false;
    this.pingTimer = 0;
    this.retryTimer = 0;
    this.text = new TextDecoder('utf-8');
  }

  Link.CMD_START = 0;
  Link.KEY_PIXEL = 2;
  Link.KEY_MODE = 11;

  Link.prototype.on = function (name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  };

  Link.prototype.fire = function (name, arg) {
    var list = this.listeners[name] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { console.error(e); }
    }
  };

  Link.prototype.connect = function (hello) {
    if (hello) this.hello = hello;
    this.shutdown();
    var self = this;
    var ws = new WebSocket(URL_WS, 'tsl');
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    var giveUp = setTimeout(function () { try { ws.close(); } catch (e) { /* ignore */ } }, OPEN_TIMEOUT);

    ws.onopen = function () {
      clearTimeout(giveUp);
      if (ws !== self.ws) return;
      self.open = true;
      self.ping = 0; self.pong = 0; self.checking = false;
      self.sendHello();
      self.pingTimer = setInterval(function () { self.tick(); }, 1000);
      self.fire('open');
    };
    ws.onclose = function (ev) {
      clearTimeout(giveUp);
      if (ws !== self.ws) return;
      self.shutdown();
      self.fire('close', ev.code);
      self.retry(1000);
    };
    ws.onerror = function () { /* onclose follows */ };
    ws.onmessage = function (ev) { if (ws === self.ws) self.receive(ev.data); };
  };

  /* Close the socket without reconnecting (another page has the adapter). */
  Link.prototype.stop = function () {
    clearTimeout(this.retryTimer);
    this.shutdown();
  };

  Link.prototype.shutdown = function () {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    this.open = false;
    var ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
  };

  Link.prototype.retry = function (ms) {
    var self = this;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () { self.connect(); }, ms);
  };

  /* Pings once a second; the adapter echoes the counter in its status messages. When the echo
   * stops, ask the adapter's web server: if it answers, another page took the adapter over (stay
   * off, reconnecting would only fight it); if it does not, the link is gone (reconnect). */
  Link.prototype.tick = function () {
    if (!this.open) return;
    var buf = new ArrayBuffer(8), v = new DataView(buf);
    v.setInt16(0, 4, true); v.setInt16(2, 12, true); v.setUint32(4, this.ping, true);
    this.send(buf);
    this.ping++;
    if (this.ping - this.pong > PONG_LATE && !this.checking) this.check();
  };

  Link.prototype.check = function () {
    var self = this, ws = this.ws;
    this.checking = true;
    var ctl = global.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 3000);
    fetch(URL_HTTP + '?alive=' + Date.now(), { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function () { return true; }, function () { return false; })
      .then(function (alive) {
        clearTimeout(t);
        if (ws !== self.ws) return;
        setTimeout(function () {
          if (ws !== self.ws) return;
          self.checking = false;
          if (self.ping - self.pong <= PONG_LATE) return;      // answers came back meanwhile
          if (alive) { self.stop(); self.fire('superseded'); }
          else { self.shutdown(); self.fire('close', 'no answer'); self.retry(1000); }
        }, alive ? 2000 : 0);
      });
  };

  Link.prototype.send = function (buf) {
    if (!this.open || !this.ws) return false;
    try { this.ws.send(buf); return true; } catch (e) { return false; }
  };

  function words(type, values) {
    var v = new DataView(new ArrayBuffer(4 + values.length * 2));
    v.setInt16(0, values.length * 2, true);
    v.setInt16(2, type, true);
    for (var i = 0; i < values.length; i++) v.setInt16(4 + i * 2, values[i], true);
    return v.buffer;
  }

  Link.prototype.sendHello = function () {
    var enc = new TextEncoder();
    var lang = enc.encode(String(this.hello.lang || 'en').slice(0, 10));
    var nav = enc.encode(String(this.hello.nav || 'null').slice(0, 120));
    var size = 4 + lang.length + 1 + nav.length + 1;
    var out = new Uint8Array(4 + size), v = new DataView(out.buffer);
    v.setInt16(0, size, true); v.setInt16(2, 2, true);
    v.setInt16(4, this.hello.w | 0, true); v.setInt16(6, this.hello.h | 0, true);
    out.set(lang, 8);
    out.set(nav, 8 + lang.length + 1);
    this.send(out.buffer);
  };

  Link.prototype.touch = function (action, x, y) { this.send(words(1, [action, x, y])); };
  Link.prototype.command = function (c) { this.send(words(3, [c])); };
  Link.prototype.setting = function (key, value) { this.send(words(7, [key, value])); };
  Link.prototype.night = function (on) { this.send(words(8, [on ? 1 : 0])); };

  Link.prototype.receive = function (data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 8) return;
    var v = new DataView(data);
    var len = v.getUint32(0, true), type = v.getUint32(4, true);
    if (len !== data.byteLength - 8) return;
    if (type > 4) return;                         // video units, QR, reload…: not used here
    var obj;
    try { obj = JSON.parse(this.text.decode(new Uint8Array(data, 8))); } catch (e) { return; }
    if (type === 0 || type === 4) { if (typeof obj.pong === 'number') this.pong = obj.pong; }
    else if (type === 1) this.fire('init', obj);
    else if (type === 3) this.fire('link', obj);
  };

  global.Link = Link;
})(window);
