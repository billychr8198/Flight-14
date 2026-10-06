/* Flight 14-CA: image-sequence player for scroll-scrubbed canvases.
   Frames load coarse-to-fine (every 16th, then 8th, 4th, 2nd, all) so scrubbing
   works almost immediately and sharpens as the rest arrive. Drawing only happens
   when the frame (or overlay) actually changes. */
(function () {
  'use strict';

  const pad = (n) => String(n).padStart(4, '0');

  // Phones in portrait only ever show the middle of a 16:9 frame, so they load the
  // window-centred crop set: same sharpness, about a third of the bytes.
  function pickVariant(meta) {
    if (!meta) return meta;
    const tall = window.innerWidth / Math.max(1, window.innerHeight) <= 0.8;
    return tall && meta.portrait ? meta.portrait : meta;
  }

  function Sequence(meta, name) {
    meta = pickVariant(meta);
    this.name = name;
    this.meta = meta;
    this.count = meta ? meta.count : 0;
    this.frames = new Array(this.count);
    this.loaded = 0;
    this.listeners = [];
  }

  Sequence.prototype.url = function (i) {
    return this.meta.dir + 'f_' + pad(i + 1) + '.' + this.meta.ext;
  };

  Sequence.prototype.order = function () {
    const seen = new Uint8Array(this.count), out = [];
    [16, 8, 4, 2, 1].forEach((step) => {
      for (let i = 0; i < this.count; i += step) if (!seen[i]) { seen[i] = 1; out.push(i); }
    });
    if (this.count && !seen[this.count - 1]) out.push(this.count - 1);
    return out;
  };

  // Load every frame; resolves when the first `ready` frames (the coarse pass) are in.
  Sequence.prototype.load = function (concurrency, ready) {
    const queue = this.order();
    const firstPass = Math.min(queue.length, ready || 13);
    let inFlight = 0, done = 0;
    return new Promise((resolveReady) => {
      if (!queue.length) { resolveReady(); return; }
      const next = () => {
        while (inFlight < concurrency && queue.length) {
          const i = queue.shift();
          inFlight++;
          const img = new Image();
          img.decoding = 'async';
          // the very first frame is what you see on arrival; everything after it streams in quietly
          try { img.fetchPriority = done === 0 && inFlight === 1 ? 'high' : 'low'; } catch (e) { /* older browsers */ }
          img.src = this.url(i);
          const finish = (ok) => {
            inFlight--; done++;
            if (ok) { this.frames[i] = img; this.loaded++; }
            this.listeners.forEach((f) => f(this.loaded, this.count));
            if (done === firstPass) resolveReady();
            next();
          };
          (img.decode ? img.decode() : new Promise((r, j) => { img.onload = r; img.onerror = j; }))
            .then(() => finish(true), () => finish(false));
        }
      };
      next();
    });
  };

  Sequence.prototype.onProgress = function (f) { this.listeners.push(f); };

  // The loaded frame closest to i (frames arrive out of order).
  Sequence.prototype.nearest = function (i) {
    if (this.frames[i]) return this.frames[i];
    for (let d = 1; d < this.count; d++) {
      if (i - d >= 0 && this.frames[i - d]) return this.frames[i - d];
      if (i + d < this.count && this.frames[i + d]) return this.frames[i + d];
    }
    return null;
  };

  // ---------------------------------------------------------------- canvas stage
  function Stage(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.key = '';
    this.resize();
  }

  Stage.prototype.resize = function () {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.key = '';
    }
  };

  // Cover-fit an image, with an optional focus point so tall phones keep the window centred.
  Stage.prototype.cover = function (img, alpha) {
    if (!img) return;
    const cw = this.canvas.width, ch = this.canvas.height;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(cw / iw, ch / ih);
    const dw = iw * s, dh = ih * s;
    const g = this.ctx;
    g.globalAlpha = alpha == null ? 1 : alpha;
    g.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    g.globalAlpha = 1;
  };

  // Draw `seq` at progress p (0..1); optionally crossfade an overlay image on top.
  Stage.prototype.draw = function (seq, p, overlay, overlayAlpha) {
    let img = null, idx = -1;
    if (seq && seq.count) {
      idx = Math.round(Math.max(0, Math.min(1, p)) * (seq.count - 1));
      img = seq.nearest(idx);
    }
    const oa = overlay ? Math.round((overlayAlpha || 0) * 100) / 100 : 0;
    const key = (img ? img.src : 'none') + '|' + (overlay && oa > 0 ? overlay.src + oa : '');
    if (key === this.key) return false;
    this.key = key;
    const g = this.ctx;
    if (!img && !(overlay && oa > 0)) {
      const grad = g.createLinearGradient(0, 0, 0, this.canvas.height);
      grad.addColorStop(0, '#f2a25c'); grad.addColorStop(0.5, '#1d4f73'); grad.addColorStop(1, '#0d2438');
      g.fillStyle = grad; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return true;
    }
    if (img) this.cover(img, 1);
    if (overlay && oa > 0) this.cover(overlay, oa);
    return true;
  };

  window.F14Frames = { Sequence: Sequence, Stage: Stage };
})();
