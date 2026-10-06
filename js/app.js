/* Flight 14-CA
   Timer accuracy: the clock is never counted down tick by tick. Each session
   stores the wall-clock time it ends (endAt) and the display is derived from
   Date.now(). Ticks come from a Web Worker, which keeps firing while the page
   scrolls, while canvases redraw and while the tab sits in the background, and
   the chime is queued on the Web Audio clock the moment a session starts. */
(function () {
  'use strict';

  const D = window.GH_DATA, SPOTS = D.spots, TOTAL = SPOTS.length;
  const MEDIA = window.F14_MEDIA || null;
  const HOUR = 3600000;
  const KEY = 'flight14ca.v1';
  const DEFAULT_TITLE = document.title;
  const MODE_NAME = { focus: 'Focus', short: 'Break', long: 'Long break' };
  const STATUS = { focus: 'Time to focus', short: 'Time for a break', long: 'Long break' };
  // every stop's window view (an edit of the hero plate), by spot number
  const PLATE_FOR = {
    1: 'yosemite', 2: 'goldengate', 3: 'redwoods', 4: 'deathvalley', 5: 'bigsur', 6: 'tahoe', 7: 'joshuatree', 8: 'sequoia',
    9: 'anaheim', 10: 'hollywood', 11: 'alcatraz', 12: 'monterey', 13: 'santamonica', 14: 'pointreyes', 15: 'lassen',
    16: 'shasta', 17: 'napa', 18: 'santabarbara', 19: 'channelislands', 20: 'sandiego', 21: 'catalina', 22: 'pinnacles',
    23: 'palmsprings', 24: 'mendocino', 25: 'monolake', 26: 'kingscanyon', 27: 'winchester', 28: 'hearst', 29: 'muirwoods', 30: 'venice'
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => Date.now();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const smooth = (t) => t * t * (3 - 2 * t);
  const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- state
  function defaults() {
    return {
      settings: { focus: 60, short: 10, long: 40, interval: 4, autoBreaks: false, autoFocus: false, chime: true, volume: 70, repeat: 2, narrate: false, rate: 1, music: true, musicVol: 45, musicPauseFocus: false },
      timer: { mode: 'focus', running: false, endAt: 0, remaining: 3600000, duration: 3600000, credited: 0, cycle: 0 },
      progress: { focusMs: 0, unlocked: 0, sessions: 0, arrivals: [] },
      tasks: [], activeTask: null
    };
  }
  function merge(base, src) {
    if (!src || typeof src !== 'object') return base;
    Object.keys(base).forEach((k) => {
      if (!(k in src)) return;
      const b = base[k], v = src[k];
      if (b && typeof b === 'object' && !Array.isArray(b)) merge(b, v);
      else if (Array.isArray(b)) { if (Array.isArray(v)) base[k] = v; }
      else if (v === null || b === null || typeof v === typeof b) base[k] = v;
    });
    return base;
  }
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) return merge(defaults(), JSON.parse(raw)); } catch (e) { /* storage blocked */ }
    return defaults();
  }
  let S = load();
  (function sanitize() {
    const st = S.settings;
    st.focus = clamp(Math.round(+st.focus) || 60, 1, 180);
    st.short = clamp(Math.round(+st.short) || 10, 1, 60);
    st.long = clamp(Math.round(+st.long) || 40, 1, 120);
    st.interval = clamp(Math.round(+st.interval) || 4, 1, 12);
    st.repeat = clamp(Math.round(+st.repeat) || 2, 1, 5);
    if (!MODE_NAME[S.timer.mode]) S.timer.mode = 'focus';
    S.progress.unlocked = clamp(Math.min(S.progress.unlocked | 0, Math.floor(S.progress.focusMs / HOUR)), 0, TOTAL);
  })();
  let saveT = 0;
  function save() { clearTimeout(saveT); saveT = 0; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  function saveSoon() { if (!saveT) saveT = setTimeout(save, 1500); }

  const T = () => S.timer;
  const modeMs = (m) => S.settings[m] * 60000;
  const remainingMs = () => (T().running ? Math.max(0, T().endAt - now()) : T().remaining);
  const elapsedMs = () => clamp(T().duration - remainingMs(), 0, T().duration);
  const started = () => T().running || T().remaining < T().duration;

  // debug hooks used by the automated checks (harmless in production)
  const debug = { completions: [], ticks: 0, lastTickAt: 0, maxGap: 0, gaps: [] };
  window.F14 = { state: () => S, debug: debug };

  // ---------------------------------------------------------------- elements
  const el = {
    body: document.body,
    clock: $('#clock'), bar: $('#sessionBar'), start: $('#startBtn'), reset: $('#resetBtn'), skip: $('#skipBtn'),
    tabs: $$('.tab'), sessionNo: $('#sessionNo'), status: $('#statusText'), working: $('#workingOn'),
    deckNext: $('#deckNext'), deckLeft: $('#deckLeft'), deckLine: $('#deckLine'),
    pillNum: $('#meterPillNum'), chimeBtn: $('#chimeBtn'),
    dock: $('#dock'), dockClock: $('#dockClock'), dockMode: $('#dockMode'), dockStart: $('#dockStart'),
    titlecard: $('#titlecard'), deck: $('#deck'), console: $('#console'),
    meter: $('.meter'), countNum: $('#countNum'), ticks: $('#ticks'), meterNext: $('#meterNext'),
    reveal: $('#reveal'), revHour: $('#revHour'), revName: $('#revName'), revRegion: $('#revRegion'), revText: $('#revText'), revListen: $('#revListen'),
    track: $('#track'), itin: $('#itinGrid'), sr: $('#sr'), footStats: $('#footStats')
  };
  const sections = { flight: $('#flight'), unlock: $('#unlock'), windows: $('#windows') };
  function announce(msg) { el.sr.textContent = ''; setTimeout(() => { el.sr.textContent = msg; }, 50); }

  // ---------------------------------------------------------------- audio
  function applyVolume() { if (window.GHAudio) GHAudio.setVolume(S.settings.volume / 100); }
  function scheduleAlarm() {
    if (!window.GHAudio || !T().running) return;
    if (!S.settings.chime) { GHAudio.cancelAlarm(); return; }
    GHAudio.scheduleAlarm('cabin-chime', (T().endAt - now()) / 1000, S.settings.repeat, T().endAt);
  }
  function renderChime() {
    el.chimeBtn.setAttribute('aria-pressed', S.settings.chime ? 'true' : 'false');
    el.chimeBtn.title = S.settings.chime ? 'Chime on' : 'Chime off';
    el.chimeBtn.setAttribute('aria-label', S.settings.chime ? 'Chime is on. Turn it off' : 'Chime is off. Turn it on');
  }
  el.chimeBtn.addEventListener('click', () => {
    S.settings.chime = !S.settings.chime;
    renderChime(); save();
    if (S.settings.chime) { GHAudio.unlock(); applyVolume(); GHAudio.play('cabin-chime', 0.8); scheduleAlarm(); }
    else GHAudio.cancelAlarm();
  });

  // ---------------------------------------------------------------- soundtrack
  // Loops quietly under everything. Browsers only allow music after the first click or key press,
  // so it fades in then. It dips under the chime and the narration, and can pause during focus.
  const music = (function () {
    const btn = $('#musicBtn');
    const a = new Audio();
    a.src = 'assets/audio/soundtrack.mp3'; a.loop = true; a.preload = 'none';
    let ctx = null, gain = null, allowed = false, available = true, level = 0, duck = 1, fadeT = 0, lastWanted = null;
    a.addEventListener('error', () => { available = false; btn.hidden = true; });
    function graph() {
      // Web Audio gain works on phones too (iOS ignores audio.volume); file:// pages fall back to audio.volume
      if (ctx || !/^https?:$/.test(location.protocol) || !window.AudioContext) return;
      try { ctx = new AudioContext(); gain = ctx.createGain(); gain.gain.value = 0; ctx.createMediaElementSource(a).connect(gain).connect(ctx.destination); }
      catch (e) { ctx = null; gain = null; }
    }
    function set(v) { level = v; if (gain) gain.gain.value = v; else a.volume = clamp(v, 0, 1); }
    function fadeTo(v, ms) {
      clearInterval(fadeT);
      const from = level, steps = Math.max(1, Math.round(ms / 40)); let k = 0;
      fadeT = setInterval(() => {
        k++; set(from + (v - from) * (k / steps));
        if (k >= steps) { clearInterval(fadeT); if (v === 0 && !wanted()) a.pause(); }
      }, 40);
    }
    function wanted() {
      return allowed && available && S.settings.music && !(S.settings.musicPauseFocus && T().running && T().mode === 'focus');
    }
    function sync(force) {
      const w = wanted();
      if (!force && w === lastWanted) return;
      lastWanted = w;
      if (w) {
        if (a.paused) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
        fadeTo((S.settings.musicVol / 100) * duck, 1600);
      } else if (!a.paused) fadeTo(0, 900);
    }
    function render() {
      btn.setAttribute('aria-pressed', S.settings.music ? 'true' : 'false');
      btn.title = S.settings.music ? 'Music on' : 'Music off';
      btn.setAttribute('aria-label', S.settings.music ? 'Music is on. Turn it off' : 'Music is off. Turn it on');
    }
    function unlock() {
      if (allowed) return;
      allowed = true; graph();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      sync(true);
    }
    ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
    btn.addEventListener('click', () => { S.settings.music = !S.settings.music; save(); render(); unlock(); sync(true); });
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Flight 14-CA soundtrack', artist: 'Golden State Airlines', artwork: [{ src: 'assets/img/icon-192.png', sizes: '192x192', type: 'image/png' }] }); } catch (e) { /* ignore */ }
    }
    render();
    return {
      sync: sync, render: render,
      // dip the music (0..1) while something else speaks or rings
      duck: (f) => { duck = f; if (!a.paused && wanted()) fadeTo((S.settings.musicVol / 100) * duck, 500); },
      duckFor: (f, ms) => { duck = f; if (!a.paused && wanted()) fadeTo((S.settings.musicVol / 100) * f, 300); setTimeout(() => { duck = 1; if (!a.paused && wanted()) fadeTo(S.settings.musicVol / 100, 1500); }, ms); },
      volume: () => { if (!a.paused && wanted()) fadeTo((S.settings.musicVol / 100) * duck, 200); },
      state: () => ({ allowed: allowed, available: available, paused: a.paused, level: Math.round(level * 100) / 100, src: a.currentSrc })
    };
  })();
  window.F14.music = music.state;

  // ---------------------------------------------------------------- narrator
  const speech = window.speechSynthesis;
  let voice = null, speakingBtn = null, speakToken = 0;
  function pickVoice() {
    if (!speech) return;
    const vs = speech.getVoices(); if (!vs.length) return;
    const us = vs.filter((v) => /^en[-_]US/i.test(v.lang));
    const pool = us.length ? us : vs.filter((v) => /^en/i.test(v.lang));
    const pref = ['Samantha', 'Google US English', 'Jenny', 'Aria', 'Ava', 'Allison', 'Zira'];
    voice = null;
    for (let i = 0; i < pref.length && !voice; i++) voice = pool.find((v) => v.name.indexOf(pref[i]) >= 0) || null;
    voice = voice || pool[0] || vs[0];
  }
  if (speech) { pickVoice(); speech.onvoiceschanged = pickVoice; }
  function chunks(paras) {
    const out = [];
    paras.forEach((p) => {
      const parts = p.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["\u201d\u2019]?\s*|[^.!?]+$/g) || [p];
      let buf = '';
      parts.forEach((s) => { if ((buf + s).length > 220 && buf) { out.push(buf.trim()); buf = ''; } buf += s; });
      if (buf.trim()) out.push(buf.trim());
    });
    return out;
  }
  // Recorded narration (Gemini TTS, one MP3 per stop, see tools/build-voices.mjs) plays when it exists;
  // otherwise the browser's own voice reads the same text.
  const VOICES = window.F14_VOICES || {};
  const voiceEl = new Audio();
  voiceEl.preload = 'none';
  function speakSpot(i, btn) {
    const rec = VOICES[SPOTS[i].n];
    if (!rec) { speak(SPOTS[i].paras, btn); return; }
    stopSpeaking();
    const token = speakToken;
    speakingBtn = btn || null;
    music.duck(0.3);
    if (btn) { btn.textContent = 'Stop'; btn.setAttribute('aria-pressed', 'true'); }
    const fallback = () => { if (token === speakToken) speak(SPOTS[i].paras, btn); };
    voiceEl.onended = () => {
      if (token !== speakToken) return;
      if (btn) { btn.textContent = 'Listen'; btn.setAttribute('aria-pressed', 'false'); }
      speakingBtn = null; music.duck(1);
    };
    voiceEl.onerror = fallback;
    voiceEl.src = rec.src;
    voiceEl.playbackRate = S.settings.rate;
    const p = voiceEl.play();
    if (p && p.catch) p.catch((e) => { if (e && e.name !== 'AbortError') fallback(); });
  }
  function toggleSpeakSpot(i, btn) { if (speakingBtn === btn) stopSpeaking(); else speakSpot(i, btn); }
  window.F14.voice = () => ({ src: voiceEl.currentSrc, paused: voiceEl.paused, time: Math.round(voiceEl.currentTime * 10) / 10, recorded: Object.keys(VOICES).length });

  function stopSpeaking() {
    speakToken++;
    if (speech) speech.cancel();
    if (!voiceEl.paused) voiceEl.pause();
    if (speakingBtn) { speakingBtn.textContent = 'Listen'; speakingBtn.setAttribute('aria-pressed', 'false'); }
    speakingBtn = null;
    music.duck(1);
  }
  function speak(paras, btn) {
    stopSpeaking();
    if (!speech) { if (btn) { btn.disabled = true; btn.title = 'This browser has no built-in voice'; } return; }
    const token = speakToken, parts = chunks(paras);
    speakingBtn = btn || null;
    music.duck(0.3);
    if (btn) { btn.textContent = 'Stop'; btn.setAttribute('aria-pressed', 'true'); }
    let i = 0;
    (function next() {
      if (token !== speakToken) return;
      if (i >= parts.length) { if (btn) { btn.textContent = 'Listen'; btn.setAttribute('aria-pressed', 'false'); } speakingBtn = null; music.duck(1); return; }
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : 'en-US';
      u.rate = S.settings.rate; u.pitch = 1.04;
      u.onend = next; u.onerror = next;
      speech.speak(u);
    })();
  }
  function toggleSpeak(paras, btn) { if (speakingBtn === btn) stopSpeaking(); else speak(paras, btn); }

  // ---------------------------------------------------------------- timer core
  function setMode(mode, opts) {
    opts = opts || {};
    const t = T();
    if (window.GHAudio) GHAudio.cancelAlarm();
    t.mode = mode; t.running = false; t.duration = t.remaining = modeMs(mode); t.credited = 0; t.endAt = 0;
    el.body.dataset.mode = mode;
    el.body.classList.remove('running');
    aimWakeup(); save(); render(true); renderTasks(); music.sync();
    if (opts.autostart) start(true);
  }
  function start(auto) {
    const t = T();
    if (t.running) return;
    if (t.remaining <= 0) { t.remaining = t.duration; t.credited = 0; }
    t.endAt = now() + t.remaining; t.running = true;
    el.body.classList.add('running');
    if (!auto && window.GHAudio) GHAudio.click();
    scheduleAlarm(); aimWakeup(); save(); render(true);
    announce(MODE_NAME[t.mode] + ' started, ' + Math.round(t.remaining / 60000) + ' minutes.');
  }
  function pause() {
    const t = T();
    if (!t.running) return;
    creditFocus();
    t.remaining = Math.max(0, t.endAt - now()); t.running = false;
    el.body.classList.remove('running');
    if (window.GHAudio) { GHAudio.cancelAlarm(); GHAudio.click(); }
    aimWakeup(); save(); render(true); announce('Paused.');
  }
  const toggle = () => (T().running ? pause() : start());

  function creditFocus() {
    const t = T();
    if (t.mode !== 'focus') return;
    const e = elapsedMs(), delta = e - t.credited;
    if (delta <= 0) return;
    t.credited = e;
    S.progress.focusMs += delta;
    saveSoon();
    checkUnlock();
  }

  function complete(natural, silent) {
    const t = T(), was = t.mode, endAt = t.endAt;
    if (t.running && natural) t.endAt = Math.min(t.endAt, now());
    creditFocus();
    const elapsed = elapsedMs();
    debug.completions.push({ mode: was, endAt: endAt, firedAt: now(), natural: !!natural });
    t.running = false; t.remaining = 0;
    el.body.classList.remove('running');
    if (natural && !silent && S.settings.chime) music.duckFor(0.2, 4500);
    if (window.GHAudio) {
      if (natural && !silent && S.settings.chime) {
        if (GHAudio.alarmCovers(endAt)) GHAudio.releaseAlarm();
        else { GHAudio.scheduleAlarm('cabin-chime', 0, S.settings.repeat, 0); GHAudio.releaseAlarm(); }
      } else GHAudio.cancelAlarm();
    }
    let next;
    if (was === 'focus') {
      t.cycle++;
      if (elapsed >= 60000) {
        S.progress.sessions++;
        const task = S.tasks.find((x) => x.id === S.activeTask);
        if (task && !task.done) task.act++;
      }
      next = t.cycle % S.settings.interval === 0 ? 'long' : 'short';
    } else next = 'focus';
    announce(was === 'focus' ? 'Focus session complete. Time for a ' + MODE_NAME[next].toLowerCase() + '.' : 'Break over. Back to focus.');
    setMode(next, { autostart: !silent && (next === 'focus' ? S.settings.autoFocus : S.settings.autoBreaks) });
  }

  function tick() {
    const tNow = now();
    if (debug.lastTickAt) { const gap = tNow - debug.lastTickAt; if (gap > debug.maxGap) debug.maxGap = gap; debug.gaps.push(gap); if (debug.gaps.length > 2000) debug.gaps.shift(); }
    debug.ticks++; debug.lastTickAt = tNow;
    const t = T();
    if (t.running && now() >= t.endAt) { complete(true); return; }
    if (t.running) creditFocus();
    render();
    music.sync();
  }
  // Worker clock: a steady 250 ms tick, plus a one-shot wake-up aimed at the exact end of the session.
  let worker = null, wakeT = 0;
  function aimWakeup() {
    const ms = T().running ? Math.max(0, T().endAt - now()) : -1;
    if (worker) worker.postMessage(ms);
    else { clearTimeout(wakeT); if (ms >= 0) wakeT = setTimeout(tick, ms + 5); }
  }
  (function startTicker() {
    try {
      const src = 'setInterval(function(){postMessage(0)},250);var w=0;' +
        'onmessage=function(e){clearTimeout(w);if(e.data>=0)w=setTimeout(function(){postMessage(1)},e.data+5);};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = tick;
      worker.onerror = () => { worker = null; setInterval(tick, 250); aimWakeup(); };
    } catch (e) { worker = null; }
    if (!worker) setInterval(tick, 250);
    ['visibilitychange', 'focus', 'pageshow'].forEach((ev) => window.addEventListener(ev, () => {
      if (!document.hidden) { tick(); flushReveal(); }
    }));
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('pagehide', save);
  })();

  // ---------------------------------------------------------------- render HUD
  function fmt(ms) {
    const s = Math.ceil(ms / 1000), m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  let lastSec = -1, lastTitle = '';
  function render(force) {
    const t = T(), rem = remainingMs(), sec = Math.ceil(rem / 1000);
    if (force || sec !== lastSec) {
      lastSec = sec;
      const txt = fmt(rem);
      el.clock.innerHTML = txt.split('').map((c) => (c === ':' ? '<span class="c">:</span>' : '<span class="d">' + c + '</span>')).join('');
      el.clock.setAttribute('aria-label', MODE_NAME[t.mode] + ', ' + txt + ' left');
      el.dockClock.textContent = txt;
      el.bar.style.width = (t.duration ? (1 - rem / t.duration) * 100 : 0).toFixed(2) + '%';
      const title = started() ? txt + ' ' + MODE_NAME[t.mode] + ' | Flight 14-CA' : DEFAULT_TITLE;
      if (title !== lastTitle) { document.title = title; lastTitle = title; }
      renderProgressText();
    }
    const label = t.running ? 'Pause' : started() ? 'Resume' : 'Start';
    if (el.start.textContent !== label) { el.start.textContent = label; el.dockStart.textContent = label; }
    el.tabs.forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === t.mode ? 'true' : 'false'));
    el.dockMode.textContent = MODE_NAME[t.mode];
    el.sessionNo.textContent = 'Session ' + (t.mode === 'focus' ? t.cycle + 1 : Math.max(1, t.cycle));
    el.status.textContent = STATUS[t.mode];
  }

  function renderProgressText() {
    const p = S.progress, u = p.unlocked;
    el.pillNum.textContent = u;
    const into = p.focusMs - u * HOUR;
    const left = Math.max(1, Math.ceil((HOUR - into) / 60000));
    const next = SPOTS[u];
    if (next) {
      el.deckNext.textContent = next.short;
      el.deckLeft.textContent = left + ' min of focus';
      el.meterNext.innerHTML = 'Next: <b>' + esc(next.short) + '</b>, ' + left + ' min of focus away.';
    } else {
      el.deckNext.textContent = 'Home';
      el.deckLeft.textContent = 'All 30 visited';
      el.meterNext.textContent = 'All thirty stops visited. Every hour from here is a victory lap.';
    }
    const t = T();
    el.deckLine.textContent = !next ? 'All thirty stops visited. Thank you for flying with us.'
      : t.mode === 'focus' ? (t.running ? 'Cruising altitude. Focus mode is on.' : 'Seatbelts fastened. Press start when you are ready.')
      : t.mode === 'short' ? 'The seatbelt sign is off. Stretch your legs.' : 'Long layover. Rest up, captain\u2019s orders.';
    el.footStats.textContent = (p.focusMs / HOUR).toFixed(1) + ' hours flown, ' + p.sessions + ' sessions';
    // ticks
    $$('li', el.ticks).forEach((li, i) => { li.className = i < u ? 'on' : i === u ? 'next' : ''; });
  }

  // ---------------------------------------------------------------- controls
  el.start.addEventListener('click', toggle);
  el.dockStart.addEventListener('click', toggle);
  el.reset.addEventListener('click', () => {
    if (!started()) return;
    confirmBox('Restart this session?', 'The clock goes back to ' + S.settings[T().mode] + ':00. Focus time you already put in still counts.', 'Restart')
      .then((ok) => { if (ok) { creditFocus(); setMode(T().mode); } });
  });
  el.skip.addEventListener('click', () => {
    if (T().mode !== 'focus') { complete(false); return; }
    const m = Math.floor(elapsedMs() / 60000);
    confirmBox('End this focus session now?', (m ? 'The ' + m + ' min you focused still count toward your next stop. ' : '') + 'You will move on to your break.', 'End session')
      .then((ok) => { if (ok) complete(false); });
  });
  el.tabs.forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (m === T().mode && !started()) return;
    if (!started()) { setMode(m); return; }
    confirmBox('Leave this session?', 'The timer is running. Switch to ' + MODE_NAME[m].toLowerCase() + ' anyway? Focus time you already put in still counts.', 'Switch')
      .then((ok) => { if (ok) { creditFocus(); setMode(m); } });
  }));
  el.sessionNo.addEventListener('click', () => {
    confirmBox('Reset the session count?', 'Counting starts again from session 1. Hours and unlocked stops stay.', 'Reset count')
      .then((ok) => { if (ok) { T().cycle = 0; save(); render(true); } });
  });
  document.addEventListener('keydown', (e) => {
    if ((e.code !== 'Space' && e.key !== ' ') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT|BUTTON|A/.test(tag) || anyDialogOpen()) return;
    e.preventDefault(); toggle();
  });

  // ---------------------------------------------------------------- dialogs
  const dialogs = $$('dialog');
  const anyDialogOpen = () => dialogs.some((d) => d.open);
  function openDlg(d) { if (!d.open) d.showModal(); if (lenis) lenis.stop(); }
  function closeDlg(d) { if (d.open) d.close(); }
  dialogs.forEach((d) => {
    d.addEventListener('close', () => { if (!anyDialogOpen()) { if (lenis) lenis.start(); flushReveal(); } });
    d.addEventListener('click', (e) => {
      if (e.target !== d || d.id === 'confirmDlg') return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDlg(d);
    });
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeDlg(b.closest('dialog'))));

  let cfResolve = null;
  function confirmBox(title, text, yes, danger) {
    $('#cfTitle').textContent = title; $('#cfText').textContent = text;
    const y = $('#cfYes'); y.textContent = yes || 'Continue'; y.className = 'btn ' + (danger ? 'btn-danger' : 'btn-sun');
    openDlg($('#confirmDlg')); y.focus();
    return new Promise((res) => { cfResolve = res; });
  }
  function settle(v) { const r = cfResolve; cfResolve = null; closeDlg($('#confirmDlg')); if (r) r(v); }
  $('#cfYes').addEventListener('click', () => settle(true));
  $('#cfNo').addEventListener('click', () => settle(false));
  $('#confirmDlg').addEventListener('close', () => { if (cfResolve) settle(false); });

  // ---------------------------------------------------------------- tasks
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  function renderTasks() {
    const list = $('#taskList');
    list.innerHTML = S.tasks.length ? S.tasks.map((t) =>
      '<li class="task' + (t.done ? ' done' : '') + (t.id === S.activeTask ? ' active' : '') + '" data-id="' + t.id + '">' +
      '<button type="button" class="chk" aria-label="' + (t.done ? 'Mark as not finished' : 'Mark as finished') + '">' + CHECK + '</button>' +
      '<span class="t-name">' + esc(t.title) + '</span><span class="t-count" title="Pomodoros done of estimated">' + t.act + '/' + t.est + '</span>' +
      '<button type="button" class="t-del" aria-label="Delete task">&times;</button></li>').join('')
      : '<li class="empty">No tasks yet. Add one below, then tap it to work on it.</li>';
    const act = S.tasks.find((x) => x.id === S.activeTask);
    el.working.textContent = act ? act.title : 'Add a task';
    const open = S.tasks.filter((t) => !t.done);
    const left = open.reduce((a, t) => a + Math.max(0, t.est - t.act), 0);
    const sum = $('#taskSum');
    if (!S.tasks.length) { sum.textContent = ''; return; }
    let txt = 'Pomodoros <b>' + S.tasks.reduce((a, t) => a + t.act, 0) + '/' + S.tasks.reduce((a, t) => a + t.est, 0) + '</b>';
    if (left) {
      const st = S.settings; let mins = 0, cyc = T().cycle;
      for (let i = 0; i < left; i++) {
        mins += i === 0 && T().mode === 'focus' ? remainingMs() / 60000 : st.focus;
        if (i < left - 1) { cyc++; mins += cyc % st.interval === 0 ? st.long : st.short; }
      }
      if (T().mode !== 'focus') mins += remainingMs() / 60000;
      const fin = new Date(now() + mins * 60000);
      txt += ', finish at <b>' + fin.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</b> (' + (mins / 60).toFixed(1) + ' h)';
    }
    sum.innerHTML = txt;
  }
  $('#taskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#taskTitle').value.trim(); if (!title) return;
    const t = { id: 't' + Date.now().toString(36), title: title, est: clamp(parseInt($('#taskEst').value, 10) || 1, 1, 99), act: 0, done: false };
    S.tasks.push(t); if (!S.activeTask) S.activeTask = t.id;
    $('#taskTitle').value = ''; $('#taskEst').value = 1;
    save(); renderTasks(); $('#taskTitle').focus();
  });
  $('#taskList').addEventListener('click', (e) => {
    const li = e.target.closest('.task'); if (!li) return;
    const t = S.tasks.find((x) => x.id === li.dataset.id); if (!t) return;
    if (e.target.closest('.chk')) {
      t.done = !t.done;
      if (t.done && S.activeTask === t.id) { const n = S.tasks.find((x) => !x.done); S.activeTask = n ? n.id : null; }
    } else if (e.target.closest('.t-del')) {
      S.tasks = S.tasks.filter((x) => x !== t);
      if (S.activeTask === t.id) S.activeTask = null;
    } else S.activeTask = t.id;
    save(); renderTasks();
  });
  $('#clearDone').addEventListener('click', () => {
    S.tasks = S.tasks.filter((t) => !t.done);
    if (!S.tasks.some((t) => t.id === S.activeTask)) S.activeTask = null;
    save(); renderTasks();
  });
  const openTasks = () => { renderTasks(); openDlg($('#tasksDlg')); setTimeout(() => $('#taskTitle').focus(), 50); };
  $('#tasksBtn').addEventListener('click', openTasks);
  $('#workingBtn').addEventListener('click', openTasks);

  // ---------------------------------------------------------------- settings
  const form = $('#settingsForm');
  function fillSettings() {
    const st = S.settings, f = form.elements;
    ['focus', 'short', 'long', 'interval', 'repeat', 'volume', 'rate', 'musicVol'].forEach((k) => { f[k].value = st[k]; });
    ['autoBreaks', 'autoFocus', 'chime', 'narrate', 'music', 'musicPauseFocus'].forEach((k) => { f[k].checked = !!st[k]; });
    outputs();
    $('#timerHint').textContent = 'Every 60 minutes of focus unlocks the next stop, whatever length you choose.';
  }
  function outputs() {
    $('#volOut').textContent = form.elements.volume.value;
    $('#musicOut').textContent = form.elements.musicVol.value;
    $('#rateOut').textContent = (+form.elements.rate.value).toFixed(2).replace(/0$/, '') + 'x';
  }
  function readSettings(changed) {
    const st = S.settings, f = form.elements;
    const num = (k, a, b) => { const v = parseInt(f[k].value, 10); return isNaN(v) ? st[k] : clamp(v, a, b); };
    const before = st[T().mode];
    st.focus = num('focus', 1, 180); st.short = num('short', 1, 60); st.long = num('long', 1, 120);
    st.interval = num('interval', 1, 12); st.repeat = num('repeat', 1, 5); st.volume = num('volume', 0, 100);
    st.rate = clamp(parseFloat(f.rate.value) || 1, 0.7, 1.4);
    st.musicVol = num('musicVol', 0, 100);
    ['autoBreaks', 'autoFocus', 'chime', 'narrate', 'music', 'musicPauseFocus'].forEach((k) => { st[k] = f[k].checked; });
    music.render(); music.sync(true); if (changed === 'musicVol') music.volume();
    if (st[T().mode] !== before) {
      if (!started()) { T().duration = T().remaining = modeMs(T().mode); $('#timerHint').textContent = 'Saved. The clock now shows the new length.'; }
      else $('#timerHint').textContent = 'Saved. The new length starts with your next ' + MODE_NAME[T().mode].toLowerCase() + '.';
    }
    applyVolume(); renderChime();
    if (T().running && /chime|repeat/.test(changed || '')) scheduleAlarm();
    outputs(); save(); render(true); renderTasks();
  }
  form.addEventListener('input', (e) => { if (e.target.type === 'range') readSettings(e.target.name); });
  form.addEventListener('change', (e) => {
    readSettings(e.target.name);
    if (e.target.type === 'number') ['focus', 'short', 'long', 'interval', 'repeat'].forEach((k) => { form.elements[k].value = S.settings[k]; });
  });
  $$('.stepper [data-step]', form).forEach((b) => b.addEventListener('click', () => {
    const inp = $('input', b.parentNode), step = +b.dataset.step;
    let v = parseInt(inp.value, 10) || 0;
    if (Math.abs(step) === 5 && v % 5) v = step > 0 ? Math.ceil(v / 5) * 5 : Math.floor(v / 5) * 5; else v += step;
    inp.value = clamp(v, +inp.min, +inp.max);
    readSettings(inp.name);
  }));
  $('#testChime').addEventListener('click', () => { GHAudio.unlock(); applyVolume(); GHAudio.play('cabin-chime', 1); });
  $('#settingsBtn').addEventListener('click', () => { fillSettings(); openDlg($('#settingsDlg')); });
  $('#resetJourney').addEventListener('click', () => {
    confirmBox('Restart the journey?', 'Hours, unlocked stops and session counts are cleared and the plane goes back to the runway. Tasks and settings stay.', 'Restart journey', true)
      .then((ok) => {
        if (!ok) return;
        S.progress = defaults().progress; T().cycle = 0;
        featured = 0; setMode('focus'); buildItinerary(); buildPanes(); renderReveal(0); save();
        closeDlg($('#settingsDlg'));
      });
  });

  // export / import
  $('#exportBtn').addEventListener('click', () => {
    save();
    const blob = new Blob([JSON.stringify({ app: 'flight-14-ca', version: 1, data: S }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'flight-14-ca-progress.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let obj = null;
      try { obj = JSON.parse(rd.result); obj = obj && obj.data ? obj.data : obj; } catch (err) { obj = null; }
      if (!obj || !obj.progress || typeof obj.progress.focusMs !== 'number') {
        confirmBox('That file is not a Flight 14-CA backup', 'Choose a file saved with Export progress.', 'OK'); return;
      }
      confirmBox('Import this progress?', 'It has ' + (obj.progress.focusMs / HOUR).toFixed(1) + ' hours of focus and replaces the progress in this browser.', 'Import')
        .then((ok) => { if (!ok) return; S = merge(defaults(), obj); S.timer.running = false; save(); location.reload(); });
    };
    rd.readAsText(f);
  });

  // ---------------------------------------------------------------- itinerary + postcards
  const LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  let itinNear = false;
  function buildItinerary() {
    const u = S.progress.unlocked;
    el.itin.innerHTML = SPOTS.map((s, i) => {
      const open = i < u, next = i === u;
      const art = !itinNear ? '' : GHPosters.render(s.n, open || next ? null : { title: '\u2022 \u2022 \u2022', noShield: true });
      return '<li><button type="button" class="card ' + (open ? 'open' : next ? 'locked next' : 'locked') + '" data-i="' + i + '"' + (open ? '' : ' disabled') +
        ' aria-label="' + (open ? 'Hour ' + s.n + ', ' + esc(s.name) + '. Open postcard' : 'Hour ' + s.n + ', locked') + '">' +
        '<span class="card-art">' + art + (open ? '' : '<span class="lock">' + LOCK + (next ? 'Next stop' : 'Hour ' + s.n) + '</span>') + '</span>' +
        '<span class="card-n">Hour ' + s.n + '</span><span class="card-name">' + (open || next ? esc(s.short) : 'Locked') + '</span></button></li>';
    }).join('');
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { itinNear = true; io.disconnect(); buildItinerary(); } }, { rootMargin: '900px 0px' });
    io.observe(el.itin);
  } else itinNear = true;
  el.itin.addEventListener('click', (e) => { const b = e.target.closest('.card'); if (b && !b.disabled) openSpot(+b.dataset.i); });

  let spotIdx = 0;
  function openSpot(i) {
    if (i < 0 || i >= S.progress.unlocked) return;
    stopSpeaking(); spotIdx = i;
    const s = SPOTS[i], a = S.progress.arrivals.find((x) => x.n === s.n);
    $('#spArt').innerHTML = GHPosters.render(s.n);
    const photo = $('#spPhoto'), src = plateSrc(PLATE_FOR[s.n]);
    photo.hidden = !src;
    if (src) { photo.src = src; photo.alt = 'The view of ' + s.short + ' from seat 14A'; }
    $('#spHour').textContent = 'Hour ' + s.n + (a ? ', landed ' + new Date(a.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
    $('#spName').textContent = s.name;
    $('#spRegion').textContent = s.region;
    $('#spText').innerHTML = s.paras.map((p) => '<p>' + esc(p) + '</p>').join('');
    $('#spPrev').disabled = i === 0; $('#spNext').disabled = i >= S.progress.unlocked - 1;
    openDlg($('#spotDlg'));
    $('.spot-body').scrollTop = 0;
  }
  $('#spPrev').addEventListener('click', () => openSpot(spotIdx - 1));
  $('#spNext').addEventListener('click', () => openSpot(spotIdx + 1));
  $('#spListen').addEventListener('click', () => toggleSpeakSpot(spotIdx, $('#spListen')));
  $('#spotDlg').addEventListener('close', stopSpeaking);

  // ---------------------------------------------------------------- window seat panes
  // A camera roll of the latest unlocked views (up to 10) plus a glimpse of the next stop.
  const MAX_PANES = 10;
  let panes = [1];
  // opening line of the narration: whole sentences, at least ~90 characters
  const firstSentence = (p) => {
    const parts = p.match(/[^.!?]+[.!?]+["\u201d\u2019]?\s*/g) || [p];
    let out = '';
    for (let i = 0; i < parts.length && out.length < 90; i++) out += parts[i];
    return out.trim();
  };
  function plateSrc(name) { return MEDIA && MEDIA.plates && MEDIA.plates[name] ? MEDIA.plates[name] : ''; }
  function buildPanes() {
    const u = S.progress.unlocked;
    panes = [];
    for (let n = Math.max(1, u - MAX_PANES + 1); n <= u; n++) panes.push(n);
    if (u < TOTAL) panes.push(u + 1);
    const intro = u === 0 ? 'Your first view unlocks after an hour of focus.'
      : u <= MAX_PANES ? 'Every view you have unlocked, seen from seat 14A.' : 'Your latest ' + MAX_PANES + ' views from seat 14A. All 30 live in the itinerary.';
    el.track.innerHTML = panes.map((n, k) => {
      const s = SPOTS[n - 1], open = n <= u, src = plateSrc(PLATE_FOR[n]);
      return '<figure class="pane' + (open ? '' : ' locked') + (src ? '' : ' no-photo') + '">' +
        (src ? '<img src="' + src + '" alt="' + (open ? 'The view of ' + esc(s.short) + ' from the window' : '') + '" loading="lazy" decoding="async">'
             : '<div class="pane-poster" aria-hidden="true">' + GHPosters.render(n, open ? null : { title: '\u2022 \u2022 \u2022', noShield: true }) + '</div>') +
        (k === 0 ? '<div class="pane-intro"><h2>Window seat</h2><p>' + intro + '</p></div>' : '') +
        '<figcaption class="pane-cap"><p class="pane-hour">' + (open ? 'Hour ' + s.n : 'Next stop, hour ' + s.n) + '</p><h3 class="pane-name">' + (open ? esc(s.short) : 'Somewhere below the clouds') + '</h3>' +
        '<p class="pane-line">' + (open ? esc(firstSentence(s.paras[0])) : 'Unlocks after ' + n + ' hour' + (n > 1 ? 's' : '') + ' of focus.') + '</p>' +
        (open ? '<button type="button" class="btn btn-ghost" data-spot="' + (n - 1) + '">Read the postcard</button>' : '') + '</figcaption></figure>';
    }).join('');
    // one screen per view, with a little extra so each one can rest
    sections.windows.style.height = (100 + Math.max(0.4, panes.length - 1) * 75) + 'vh';
    try { if (lenis) lenis.resize(); } catch (e) { /* not created yet */ }
  }
  el.track.addEventListener('click', (e) => { const b = e.target.closest('[data-spot]'); if (b) openSpot(+b.dataset.spot); });

  // ---------------------------------------------------------------- unlock chapter: featured stop
  let featured = Math.max(0, S.progress.unlocked - 1);
  function renderReveal(i) {
    const s = SPOTS[i], open = i < S.progress.unlocked;
    el.revHour.textContent = open ? 'Hour ' + s.n + ', unlocked' : 'Your first stop';
    el.revName.textContent = s.name;
    el.revRegion.textContent = s.region;
    el.revText.innerHTML = open ? s.paras.map((p) => '<p>' + esc(p) + '</p>').join('')
      : '<p class="locked-note">Focus for 60 minutes and the clouds will part over ' + esc(s.short) + '.</p><p>' + esc(firstSentence(s.paras[0])) + '</p>';
    el.revText.scrollTop = 0;
    el.revListen.hidden = !open; $('#revPostcard').hidden = !open;
    // Yosemite is the last frame of the unlock film itself; every other stop fades to its own view
    overlayImg = null; overlayFor = s.n;
    if (s.n !== 1) getPlate(PLATE_FOR[s.n], (img) => { if (overlayFor === s.n) { overlayImg = img; stages.unlock.key = ''; } });
  }
  el.revListen.addEventListener('click', () => toggleSpeakSpot(featured, el.revListen));
  $('#revPostcard').addEventListener('click', () => openSpot(featured));
  el.revText.setAttribute('data-lenis-prevent', '');

  // ---------------------------------------------------------------- unlocking + the reveal moment
  let revealQueue = [], revealing = false, countShown = null;
  function checkUnlock() {
    const p = S.progress, n = Math.min(TOTAL, Math.floor(p.focusMs / HOUR));
    if (n <= p.unlocked) return;
    for (let i = p.unlocked; i < n; i++) { p.arrivals.push({ n: i + 1, at: now() }); revealQueue.push(i); }
    p.unlocked = n;
    save(); buildItinerary(); buildPanes(); renderProgressText();
    flushReveal();
  }
  function flushReveal() {
    if (revealing || !revealQueue.length || document.hidden || anyDialogOpen() || !booted) return;
    playReveal(revealQueue.shift());
  }
  function playReveal(i) {
    revealing = true;
    if (window.F14.loadUnlock) window.F14.loadUnlock();
    stopSpeaking();
    featured = i; renderReveal(i);
    countShown = i; // the meter shows the old count until the clouds part
    announce('Now arriving: ' + SPOTS[i].name + '.');
    const sec = sections.unlock, top = sec.offsetTop, range = sec.offsetHeight - innerHeight;
    const target = top + range * 0.92;
    let done = false, watchdog = 0;
    const finish = () => {
      if (done) return; done = true; clearTimeout(watchdog); skipReveal = null;
      if (Math.abs(scrollY - target) > 4) { if (lenis) lenis.scrollTo(target, { immediate: true, force: true }); else window.scrollTo(0, target); }
      revealing = false; countShown = null; el.body.classList.remove('revealing');
      if (S.settings.narrate) speakSpot(i, el.revListen);
      setTimeout(flushReveal, 1200);
    };
    if (!lenis || reducedMotion()) { window.scrollTo(0, target); setTimeout(finish, 400); return; }
    // One orchestrated moment: scroll input is held for ~6 s while the clouds part (Skip or Esc ends it).
    el.body.classList.add('revealing');
    skipReveal = () => { skipReveal = null; lenis.scrollTo(target, { immediate: true, force: true }); finish(); };
    watchdog = setTimeout(finish, 8500);
    lenis.scrollTo(top + range * 0.06, {
      duration: 0.9, force: true, lock: true,
      onComplete: () => { if (!done) lenis.scrollTo(target, { duration: 5, force: true, lock: true, easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2), onComplete: finish }); }
    });
  }
  let skipReveal = null;
  $('#skipReveal').addEventListener('click', () => { if (skipReveal) skipReveal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && skipReveal && !anyDialogOpen()) skipReveal(); });

  // ---------------------------------------------------------------- media + scenes
  const F = window.F14Frames;
  const seq = {
    flight: MEDIA && MEDIA.films && MEDIA.films.flight ? new F.Sequence(MEDIA.films.flight, 'flight') : null,
    unlock: MEDIA && MEDIA.films && MEDIA.films.unlock ? new F.Sequence(MEDIA.films.unlock, 'unlock') : null
  };
  const stages = { flight: new F.Stage($('#cvFlight')), unlock: new F.Stage($('#cvUnlock')) };
  const plateImgs = {};
  let overlayImg = null, overlayFor = 0;
  // plates load on demand (the reveal only needs the featured stop), falling back to the hero view
  function getPlate(name, cb) {
    if (!MEDIA || !MEDIA.plates) return;
    if (!MEDIA.plates[name]) name = 'hero';
    if (!MEDIA.plates[name]) return;
    if (plateImgs[name]) { cb(plateImgs[name]); return; }
    const im = new Image(); im.decoding = 'async'; im.src = MEDIA.plates[name];
    im.onload = () => { plateImgs[name] = im; cb(im); };
  }
  $('#standin').hidden = !(MEDIA && MEDIA.standIn);

  function progressOf(sec) {
    const top = sec.offsetTop, range = sec.offsetHeight - innerHeight;
    return clamp((scrollY - top) / Math.max(1, range), 0, 1);
  }
  function near(sec) {
    const top = sec.offsetTop - scrollY;
    return top < innerHeight * 1.2 && top + sec.offsetHeight > -innerHeight * 0.2;
  }

  let drift = 0, lastFrameT = 0, lastCount = -1;
  function scenes(t) {
    const dt = lastFrameT ? Math.min(0.1, (t - lastFrameT) / 1000) : 0; lastFrameT = t;
    // I. flight: scroll scrubs the loop twice; while the timer runs the plane keeps cruising
    if (T().running && !reducedMotion()) drift = (drift + dt / 40) % 1;
    const pf = progressOf(sections.flight);
    if (near(sections.flight)) stages.flight.draw(seq.flight, ((pf * 2 + drift) % 1 + 1) % 1);
    const tc = clamp(pf / 0.12, 0, 1);
    el.titlecard.style.opacity = (1 - tc).toFixed(3);
    el.titlecard.style.transform = 'translateY(' + (-tc * 40).toFixed(1) + 'px) scale(' + (1 + tc * 0.04).toFixed(4) + ')';
    el.titlecard.style.visibility = tc >= 1 ? 'hidden' : 'visible';
    const showWalls = pf > 0.09;
    el.deck.classList.toggle('off', !showWalls);
    el.console.classList.toggle('off', !showWalls);

    // II. unlock: clouds part with scroll; meter counts up as the chapter arrives
    const pu = progressOf(sections.unlock);
    if (window.F14.loadUnlock && sections.unlock.offsetTop - scrollY < innerHeight * 2.5) window.F14.loadUnlock();
    const q = clamp((pu - 0.06) / 0.86, 0, 1);
    if (near(sections.unlock)) {
      const fade = overlayImg ? smooth(clamp((q - 0.78) / 0.22, 0, 1)) : 0;
      stages.unlock.draw(seq.unlock, q, overlayImg, fade);
    }
    const u = S.progress.unlocked;
    let count = Math.round(u * smooth(clamp(pu / 0.3, 0, 1)));
    if (countShown !== null) count = q > 0.55 ? u : Math.min(count, countShown);
    if (count !== lastCount) { lastCount = count; el.countNum.textContent = count; }
    el.reveal.classList.toggle('off', q < 0.72);

    // III. window seat: vertical scroll drives a horizontal pan
    const pw = progressOf(sections.windows);
    // each view holds still for the first part of its scroll span, then glides to the next
    if (near(sections.windows) && panes.length > 1) {
      const x = pw * (panes.length - 1), k = Math.min(Math.floor(x), panes.length - 2), f = x - k;
      const pos = k + smooth(clamp((f - 0.4) / 0.6, 0, 1));
      el.track.style.transform = 'translate3d(' + (-pos * 100).toFixed(3) + 'vw,0,0)';
    } else if (panes.length <= 1) el.track.style.transform = 'none';

    // dock: the compact timer appears whenever the console is out of view
    const consoleVisible = showWalls && near(sections.flight) && scrollY < sections.flight.offsetTop + sections.flight.offsetHeight - innerHeight * 0.9;
    const wantDock = !consoleVisible && (pf > 0.09 || started());
    el.dock.hidden = false;
    el.dock.classList.toggle('away', !wantDock);
  }

  // ---------------------------------------------------------------- chapter navigator
  const chapterBtns = $$('.chapters [data-go]');
  function chapterTarget(k) {
    if (k === 'flight') return sections.flight.offsetTop + (sections.flight.offsetHeight - innerHeight) * 0.2;
    if (k === 'unlock') return sections.unlock.offsetTop + (sections.unlock.offsetHeight - innerHeight) * 0.92;
    if (k === 'windows') return sections.windows.offsetTop;
    return $('#itinerary').offsetTop;
  }
  chapterBtns.forEach((b) => b.addEventListener('click', () => {
    const y = chapterTarget(b.dataset.go);
    if (lenis) lenis.scrollTo(y, { duration: 1.2 }); else window.scrollTo({ top: y, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }));
  let activeChapter = '';
  function markChapter() {
    const mid = scrollY + innerHeight / 2;
    const k = mid < sections.unlock.offsetTop ? 'flight' : mid < sections.windows.offsetTop ? 'unlock' : mid < $('#itinerary').offsetTop ? 'windows' : 'itinerary';
    if (k === activeChapter) return;
    activeChapter = k;
    chapterBtns.forEach((b) => { if (b.dataset.go === k) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  }

  // ---------------------------------------------------------------- scroll engine
  let lenis = null;
  if (window.Lenis && !reducedMotion()) {
    lenis = new window.Lenis({ duration: 0.95, smoothWheel: true, wheelMultiplier: 1, touchMultiplier: 1.5 });
  }
  function loop(t) {
    if (lenis) lenis.raf(t);
    scenes(t);
    markChapter();
    requestAnimationFrame(loop);
  }
  window.addEventListener('resize', () => { stages.flight.resize(); stages.unlock.resize(); });
  document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href'); if (id.length < 2) return;
    const target = $(id); if (!target) return;
    e.preventDefault();
    let y = target.getBoundingClientRect().top + scrollY;
    if (id === '#console') y = sections.flight.offsetTop + (sections.flight.offsetHeight - innerHeight) * 0.2;
    if (id === '#unlock') y = sections.unlock.offsetTop + (sections.unlock.offsetHeight - innerHeight) * 0.92;
    if (lenis) lenis.scrollTo(y, { duration: 1.2 }); else window.scrollTo({ top: y, behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (id === '#console') setTimeout(() => el.start.focus({ preventScroll: true }), 900);
  }));
  $('#takeSeat').addEventListener('click', () => {
    const y = sections.flight.offsetTop + (sections.flight.offsetHeight - innerHeight) * 0.2;
    if (lenis) lenis.scrollTo(y, { duration: 1.3 }); else window.scrollTo(0, y);
    setTimeout(() => el.start.focus({ preventScroll: true }), 900);
  });

  // ---------------------------------------------------------------- boot
  let booted = false;
  el.ticks.innerHTML = SPOTS.map(() => '<li></li>').join('');
  el.body.dataset.mode = T().mode;
  if (T().running) {
    if (now() >= T().endAt) complete(true, true);
    else { el.body.classList.add('running'); aimWakeup(); }
  }
  if (!started()) T().duration = T().remaining = modeMs(T().mode);
  // A session restored after a reload can't queue its chime until the browser allows audio,
  // which takes a click or key press. Queue it on the first one.
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, () => {
    setTimeout(() => { if (T().running && window.GHAudio && GHAudio.isReady() && !GHAudio.alarmCovers(T().endAt)) scheduleAlarm(); }, 120);
  }, { passive: true }));
  renderChime(); applyVolume(); buildItinerary(); buildPanes(); renderReveal(featured); renderTasks(); render(true);
  requestAnimationFrame(loop);

  // Loading order, fastest first: the opening frame of the flight film, then the rest of it in
  // the background, then the unlock film once the flight is mostly in (or as soon as you head there).
  const bar = $('#preloadBar');
  ['flight', 'unlock'].forEach((k) => {
    if (!seq[k]) return;
    seq[k].onProgress(() => { stages[k].key = ''; });
  });
  if (seq.flight) seq.flight.onProgress((n) => {
    bar.style.width = Math.min(100, (n / 2) * 100).toFixed(0) + '%';
    if (n >= Math.min(60, seq.flight.count)) loadUnlock();
  });
  let unlockLoading = false;
  function loadUnlock() {
    if (unlockLoading || !seq.unlock) return;
    unlockLoading = true;
    seq.unlock.load(6, 1);
  }
  window.F14.loadUnlock = loadUnlock;
  const firstFrame = seq.flight ? seq.flight.load(6, 1) : Promise.resolve();
  if (!seq.flight) loadUnlock();
  Promise.race([firstFrame, new Promise((r) => setTimeout(r, 5000))]).then(() => {
    el.body.classList.add('ready');
    booted = true;
    setTimeout(flushReveal, 800);
  });

  // the timer is accurate across reloads: if a session ended while the page was closed, it was credited above
  window.F14.complete = complete;
  window.F14.start = start;
  window.F14.pause = pause;
})();
