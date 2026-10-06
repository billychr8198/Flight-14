#!/usr/bin/env node
/**
 * Flight 14-CA: record the flight attendant's narration for all 30 stops with Gemini TTS.
 * Based on your AI Studio script (same model, same voices, same text), but it makes
 * one MP3 per destination so each Listen button plays its own stop.
 *
 *   export GEMINI_API_KEY="your key"     (from aistudio.google.com, "Get API key")
 *   npm run voices
 *
 * Options
 *   --only 1,5,12     record just these stops (by hour number)
 *   --force           re-record stops that already have an MP3
 *   --model NAME      default from tools/voices.json
 *   --temperature N   default from tools/voices.json
 *
 * Finished files are skipped on the next run, so if Google rate-limits you or the
 * connection drops, just run it again and it carries on where it stopped.
 * The key is read from the environment only and is never written to any file.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'audio', 'narration');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const cfg = JSON.parse(readFileSync(join(ROOT, 'tools', 'voices.json'), 'utf8'));
const MODEL = opt('model', cfg.model);
const TEMPERATURE = Number(opt('temperature', cfg.temperature));
const FORCE = !!opt('force', false);
const ONLY = opt('only', null) ? String(opt('only')).split(',').map((n) => parseInt(n, 10)).filter(Boolean) : null;
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
const KEY = process.env.GEMINI_API_KEY || '';

// The narration text comes straight from the site (js/data.js), so audio and on-screen text always match.
function loadSpots() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'data.js'), 'utf8'), sandbox);
  return sandbox.window.GH_DATA.spots;
}
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fileFor = (s) => `${String(s.n).padStart(2, '0')}-${slug(s.short)}.mp3`;
const voiceFor = (s) => (s.n % 2 === 1 ? cfg.voices.odd : cfg.voices.even);

async function findFfmpeg() {
  try { const m = await import('ffmpeg-static'); if (m.default && existsSync(m.default)) return m.default; } catch { /* use PATH */ }
  return 'ffmpeg';
}
function run(bin, argv) {
  return new Promise((res, rej) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', rej); p.on('close', (code) => res({ code, err }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PCM from Gemini ("audio/L16;codec=pcm;rate=24000") -> WAV, same header as in the AI Studio script
function pcmToWav(pcm, mime) {
  const rate = parseInt((/rate=(\d+)/.exec(mime || '') || [])[1] || '24000', 10);
  const bits = parseInt((/L(\d+)/.exec(mime || '') || [])[1] || '16', 10);
  const h = Buffer.alloc(44), block = bits / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * block, 28); h.writeUInt16LE(block, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([h, pcm]), seconds: pcm.length / (rate * block) };
}

async function synthesize(spot) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: spot.paras.join('\n\n') }] }],
    generationConfig: {
      temperature: TEMPERATURE,
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(spot) } } }
    }
  };
  for (let attempt = 1; attempt <= 6; attempt++) {
    let r, data;
    try {
      r = await fetch(`${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body)
      });
      data = await r.json().catch(() => ({}));
    } catch (e) {
      if (attempt === 6) throw new Error('network error: ' + e.message);
      await sleep(5000 * attempt); continue;
    }
    if (r.ok) {
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const audio = parts.filter((p) => p.inlineData && p.inlineData.data);
      if (!audio.length) throw new Error('the reply had no audio' + (data.promptFeedback ? ' (' + JSON.stringify(data.promptFeedback) + ')' : ''));
      return { pcm: Buffer.concat(audio.map((p) => Buffer.from(p.inlineData.data, 'base64'))), mime: audio[0].inlineData.mimeType };
    }
    const msg = (data.error && data.error.message) || r.statusText;
    if (r.status === 429 || r.status >= 500) {
      // rate limit or a hiccup on Google's side: wait (as long as Google asks) and try again
      const retry = JSON.stringify(data).match(/"retryDelay":\s*"([\d.]+)s?"/);
      const wait = retry ? (Math.ceil(parseFloat(retry[1])) + 2) * 1000 : Math.min(90000, 10000 * attempt);
      // A long wait means the key's daily allowance is used up: stop now rather than sit for hours.
      if (wait > 3 * 60 * 1000) throw new QuotaStop(wait);
      console.log(`    Google says "${msg.slice(0, 90)}". Waiting ${Math.round(wait / 1000)} s, then retrying (${attempt}/5)...`);
      await sleep(wait); continue;
    }
    if (r.status === 400 && /API key/i.test(msg)) throw new Error('Google rejected the API key. Check GEMINI_API_KEY.');
    if (r.status === 404) throw new Error(`Model "${MODEL}" was not found. Copy the exact model name from AI Studio into tools/voices.json.`);
    throw new Error(`Gemini error ${r.status}: ${msg}`);
  }
  throw new QuotaStop(0);
}

class QuotaStop extends Error {
  constructor(waitMs) { super('quota'); this.waitMs = waitMs; }
}

async function encodeMp3(ff, wav, out) {
  const tmp = join(os.tmpdir(), `f14-voice-${process.pid}.wav`);
  writeFileSync(tmp, wav);
  const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', out]);
  rmSync(tmp, { force: true });
  if (r.code !== 0) throw new Error('ffmpeg could not encode the MP3:\n' + r.err);
}

function writeManifest(spots) {
  const saved = existsSync(join(OUT, 'durations.json')) ? JSON.parse(readFileSync(join(OUT, 'durations.json'), 'utf8')) : {};
  const map = {};
  for (const s of spots) {
    const f = fileFor(s);
    if (existsSync(join(OUT, f))) map[s.n] = { src: `assets/audio/narration/${f}`, voice: voiceFor(s), seconds: saved[f] || null };
  }
  writeFileSync(join(OUT, 'manifest.js'),
    `/* Written by tools/build-voices.mjs. Recorded narration for each stop; stops not listed fall back to the browser's voice. */\nwindow.F14_VOICES = ${JSON.stringify(map, null, 2)};\n`);
  return Object.keys(map).length;
}

async function main() {
  const spots = loadSpots();
  mkdirSync(OUT, { recursive: true });
  if (!KEY) {
    console.error('No API key found. In Terminal, run:\n\n  export GEMINI_API_KEY="paste-your-key-here"\n\nthen run `npm run voices` again. (Get a key at aistudio.google.com, "Get API key".)');
    process.exit(1);
  }
  const ff = await findFfmpeg();
  if ((await run(ff, ['-hide_banner', '-version']).catch(() => ({ code: 1 }))).code !== 0) {
    console.error('ffmpeg was not found. Run `npm install` first.'); process.exit(1);
  }
  const durations = existsSync(join(OUT, 'durations.json')) ? JSON.parse(readFileSync(join(OUT, 'durations.json'), 'utf8')) : {};
  writeManifest(spots);
  const todo = spots.filter((s) => (!ONLY || ONLY.includes(s.n)));
  console.log(`Recording ${todo.length} stops with ${MODEL} (voices ${cfg.voices.odd} and ${cfg.voices.even})...`);
  let made = 0, skipped = 0, failed = 0;
  for (const s of todo) {
    const f = fileFor(s), out = join(OUT, f);
    if (!FORCE && existsSync(out) && statSync(out).size > 0) { skipped++; continue; }
    process.stdout.write(`  ${String(s.n).padStart(2)} ${s.short} (${voiceFor(s)})... `);
    try {
      const { pcm, mime } = await synthesize(s);
      const { wav, seconds } = pcmToWav(pcm, mime);
      await encodeMp3(ff, wav, out);
      durations[f] = Math.round(seconds);
      writeFileSync(join(OUT, 'durations.json'), JSON.stringify(durations, null, 2));
      writeManifest(spots);
      made++;
      console.log(`${Math.round(seconds)} s`);
    } catch (e) {
      if (e instanceof QuotaStop) {
        console.log('not yet');
        const total = writeManifest(spots);
        const when = e.waitMs ? new Date(Date.now() + e.waitMs) : null;
        console.log(`\nGoogle's limit for your API key is used up for now. ${total} of ${spots.length} stops are recorded,`);
        console.log(`saved, and already playing on the site (the rest use the browser voice until then).`);
        console.log(when
          ? `Run \`npm run voices\` again after about ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${when.toLocaleDateString([], { weekday: 'long' })} and it records the rest.`
          : 'Run `npm run voices` again in a few minutes and it records the rest.');
        process.exit(0);
      }
      failed++;
      console.log('failed');
      console.error('    ' + e.message);
      if (/API key|not found/.test(e.message)) break;
    }
  }
  const total = writeManifest(spots);
  console.log(`\nDone: ${made} recorded, ${skipped} already there, ${failed} failed. ${total} of ${spots.length} stops now have recorded narration.`);
  if (failed) console.log('Run `npm run voices` again to finish the rest.');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
