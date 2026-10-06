#!/usr/bin/env node
/**
 * Flight 14-CA: turn the Higgsfield stills and films into web assets.
 *
 *   npm run frames                 download from tools/higgsfield-assets.json, then slice
 *   npm run frames -- --source dir use files already on disk (dir/hero.png ... dir/flight.mp4)
 *
 * Options
 *   --frames 200      frames per film (scroll resolution)
 *   --width 1920      output width in px (height keeps 16:9)
 *   --format webp     webp or jpg (falls back to jpg if this ffmpeg has no WebP encoder)
 *   --quality 80      0-100
 *   --force           re-download even if cached
 *   --stand-in        mark the output as placeholder footage
 *   --no-portrait     skip the phone set (window-centred 2:3 crops, about 1/3 of the weight)
 *
 * Output
 *   assets/plates/<name>.jpg
 *   assets/frames/<film>/f_0001.webp ...
 *   assets/frames/manifest.js   (window.F14_MEDIA, read by the site; works from file:// too)
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const FRAMES = parseInt(opt('frames', 200), 10);
const WIDTH = parseInt(opt('width', 1920), 10);
let FORMAT = String(opt('format', 'webp')).toLowerCase();
const QUALITY = Math.max(1, Math.min(100, parseInt(opt('quality', 80), 10)));
const FORCE = !!opt('force', false);
const STAND_IN = !!opt('stand-in', false);
const SOURCE = opt('source', null);
const PORTRAIT = !opt('no-portrait', false);

const assets = JSON.parse(readFileSync(join(ROOT, 'tools', 'higgsfield-assets.json'), 'utf8'));
const CACHE = join(ROOT, 'tools', '.cache');

async function findFfmpeg() {
  try {
    const mod = await import('ffmpeg-static');
    if (mod.default && existsSync(mod.default)) return mod.default;
  } catch { /* not installed: fall back to PATH */ }
  return 'ffmpeg';
}

function run(bin, argv, { quiet = true } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => { if (!quiet) process.stdout.write(d); });
    p.on('error', rej);
    p.on('close', (code) => res({ code, err }));
  });
}

async function download(url, to) {
  if (!FORCE && existsSync(to) && statSync(to).size > 0) return 'cached';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(to));
  return 'downloaded';
}

async function probe(ff, file) {
  const { err } = await run(ff, ['-hide_banner', '-i', file]);
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
  const s = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(err);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null,
    w: s ? +s[1] : null,
    h: s ? +s[2] : null,
  };
}

function clearDir(dir) {
  mkdirSync(dir, { recursive: true });
  // (portrait sets live in their own <film>-portrait folder)
  for (const f of readdirSync(dir)) if (/^f_\d+\.(webp|jpg)$/.test(f)) rmSync(join(dir, f));
}

async function sliceFilm(ff, name, file, variant) {
  const info = await probe(ff, file);
  if (!info.duration) throw new Error(`Could not read the duration of ${file}`);
  const portrait = variant === 'portrait';
  const outDir = join(ROOT, 'assets', 'frames', portrait ? `${name}-portrait` : name);
  const fps = FRAMES / info.duration;
  // Phones show only the middle of a 16:9 frame, so they get a sharp centre crop instead of the whole width.
  const vf = `fps=${fps.toFixed(6)},scale=${WIDTH}:-2:flags=lanczos` + (portrait ? ',crop=trunc(ih*2/3/2)*2:ih' : '');
  const encode = async (fmt) => {
    clearDir(outDir);
    const codec = fmt === 'webp'
      ? ['-c:v', 'libwebp', '-quality', String(QUALITY), '-compression_level', '4', '-preset', 'photo']
      : ['-q:v', String(Math.round(2 + (100 - QUALITY) / 10))];
    return run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', String(FRAMES), ...codec, join(outDir, `f_%04d.${fmt}`)]);
  };
  let r = await encode(FORMAT);
  if (r.code !== 0 && FORMAT === 'webp') {
    console.warn(`  This ffmpeg cannot write WebP, using JPEG instead.`);
    FORMAT = 'jpg';
    r = await encode('jpg');
  }
  if (r.code !== 0) throw new Error(`ffmpeg failed on ${name}:\n${r.err}`);
  const files = readdirSync(outDir).filter((f) => f.endsWith('.' + FORMAT)).sort();
  const height = info.w && info.h ? Math.round((WIDTH * info.h) / info.w / 2) * 2 : Math.round(WIDTH * 9 / 16);
  const width = portrait ? Math.floor(height * 2 / 3 / 2) * 2 : WIDTH;
  const bytes = files.reduce((a, f) => a + statSync(join(outDir, f)).size, 0);
  console.log(`  ${name}${portrait ? ' (phones)' : ''}: ${files.length} frames, ${width}x${height}, ${(bytes / 1048576).toFixed(1)} MB`);
  return { count: files.length, ext: FORMAT, dir: `assets/frames/${portrait ? name + '-portrait' : name}/`, width, height };
}

async function makePlate(ff, name, file) {
  const out = join(ROOT, 'assets', 'plates', `${name}.jpg`);
  mkdirSync(dirname(out), { recursive: true });
  const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `scale=${WIDTH}:-2:flags=lanczos`, '-q:v', '3', out]);
  if (r.code !== 0) throw new Error(`ffmpeg failed on plate ${name}:\n${r.err}`);
  return `assets/plates/${name}.jpg`;
}

async function main() {
  const ff = await findFfmpeg();
  const check = await run(ff, ['-hide_banner', '-version']).catch(() => ({ code: 1 }));
  if (check.code !== 0) {
    console.error('ffmpeg was not found. Run `npm install` (installs ffmpeg-static) or install ffmpeg and add it to PATH.');
    process.exit(1);
  }
  mkdirSync(CACHE, { recursive: true });

  const source = (name, ext) => (SOURCE ? resolve(SOURCE, `${name}.${ext}`) : join(CACHE, `${name}.${ext}`));
  if (!SOURCE) {
    console.log('Downloading from Higgsfield...');
    const jobs = [
      ...Object.entries(assets.stills).map(([k, v]) => [k, 'png', v.url]),
      ...Object.entries(assets.films).map(([k, v]) => [k, 'mp4', v.url]),
    ];
    for (const [name, ext, url] of jobs) {
      try {
        const how = await download(url, source(name, ext));
        console.log(`  ${name}.${ext} ${how}`);
      } catch (e) {
        if (ext === 'mp4') throw e;
        console.warn(`  ${name}.${ext} could not be downloaded (${e.message}); that stop will use the hero view.`);
      }
    }
  }
  for (const name of Object.keys(assets.films)) {
    if (!existsSync(source(name, 'mp4'))) throw new Error(`Missing ${source(name, 'mp4')}`);
  }

  console.log('Plates...');
  const plates = {}, missing = [];
  for (const name of Object.keys(assets.stills)) {
    if (!existsSync(source(name, 'png'))) { missing.push(name); continue; }
    plates[name] = await makePlate(ff, name, source(name, 'png'));
  }
  console.log(`  ${Object.keys(plates).length} plates at ${WIDTH}px` + (missing.length ? ` (not found: ${missing.join(', ')}; those stops use the hero view)` : ''));

  console.log(`Slicing films into ${FRAMES} frames each...`);
  const films = {};
  for (const name of Object.keys(assets.films)) {
    films[name] = await sliceFilm(ff, name, source(name, 'mp4'));
    if (PORTRAIT) films[name].portrait = await sliceFilm(ff, name, source(name, 'mp4'), 'portrait');
  }

  const manifest = { standIn: STAND_IN, generated: new Date().toISOString(), films, plates };
  writeFileSync(join(ROOT, 'assets', 'frames', 'manifest.js'),
    `/* Written by tools/build-frames.mjs. Do not edit by hand. */\nwindow.F14_MEDIA = ${JSON.stringify(manifest, null, 2)};\n`);
  console.log(`Done. ${STAND_IN ? 'Stand-in footage' : 'Higgsfield footage'} is in assets/. Reload the site.`);
}

main().catch((e) => { console.error('\n' + (e && e.message ? e.message : e)); process.exit(1); });
