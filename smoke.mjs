#!/usr/bin/env node
// Smoke check for the kit on this machine: one command that fails loudly when a change breaks building,
// rendering, encoding or the review tools. Writes only to teardown-out/smoke/.
//
//   npm run smoke
//
// Each check guards something that once broke:
//   webgl    headless Chromium gets a real WebGL2 context (on macOS it needs --use-angle=metal, upstream #4)
//   build    every sim in sims/ bundles to one HTML file
//   live     every *-live page loads with no page errors
//   still    every *-film sim renders a frame that is not blank
//   encode   capture writes yuv420p at limited range, not yuvj420p (upstream #8)
//   sheet    sheet.mjs refuses a --name outside <video>_sheets/ and leaves that folder alone (upstream #5)
//   sample   sfx sample() decodes a bundled recording with ffmpeg from PATH or FFMPEG (upstream #10)
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {CHROMIUM, CHROMIUM_ARGS, DIST, FFMPEG, FFPROBE, OUT, PYTHON, playwright} from './paths.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SIMS = path.join(ROOT, 'sims');
const SMOKE = path.join(OUT, 'smoke');
fs.mkdirSync(SMOKE, {recursive: true});

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({name, ok: true, note: note || ''});
  } catch (e) {
    results.push({name, ok: false, note: e.message});
  }
  const r = results.at(-1);
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${name.padEnd(26)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${r.note}`);
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {cwd: ROOT, encoding: 'utf8', env: {...process.env, TEARDOWN_OUT: OUT}});
  if (r.error) throw r.error;
  return {code: r.status, out: `${r.stdout}${r.stderr}`};
};
const node = (script, args) => run(process.execPath, [path.join(ROOT, script), ...args]);
// The line that says what went wrong: the first error line if there is one, else the last line.
const tail = (s) => {
  const lines = s.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|timeout|exceeded|not found|refused/i.test(l)) || lines.at(-1) || '').slice(0, 160);
};

const sims = fs.readdirSync(SIMS).filter((d) => fs.existsSync(path.join(SIMS, d, 'main.js'))).sort();
const films = sims.filter((d) => d.endsWith('-film'));
const lives = sims.filter((d) => d.endsWith('-live'));

const {chromium} = playwright();
const browser = await chromium.launch({executablePath: CHROMIUM, args: CHROMIUM_ARGS});

await check('webgl', async () => {
  const page = await browser.newPage();
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await page.close();
  if (!gpu) throw new Error('no WebGL2 context in headless Chromium; check CHROMIUM_ARGS in paths.mjs');
  return /swiftshader|llvmpipe|software/i.test(gpu) ? `${gpu} (software renderer: slow, check the GPU flags)` : gpu;
});

await check('build', async () => {
  const r = node('sims/build.mjs', []);
  if (r.code !== 0) throw new Error(tail(r.out));
  const missing = sims.filter((s) => !fs.existsSync(path.join(DIST, `${s}.html`)));
  if (missing.length) throw new Error(`no HTML for ${missing.join(', ')}`);
  return `${sims.length} pages`;
});

for (const live of lives) {
  await check(`live ${live}`, async () => {
    const page = await browser.newPage({viewport: {width: 1600, height: 900}});
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(pathToFileURL(path.join(DIST, `${live}.html`)).href);
    await page.waitForTimeout(3000);
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return c ? `${c.width}x${c.height}` : null;
    });
    await page.close();
    if (errors.length) throw new Error(errors[0].slice(0, 160));
    if (!canvas) throw new Error('no canvas on the page');
    return `canvas ${canvas}`;
  });
}
await browser.close();

// Spread of luma in a frame: a blank or black frame has none.
const lumaRange = (file) => {
  const r = run(FFMPEG, ['-v', 'info', '-i', file, '-vf', 'format=gray,signalstats,metadata=print', '-f', 'null', '-']);
  const lo = Number(/YMIN=(\d+)/.exec(r.out)?.[1]);
  const hi = Number(/YMAX=(\d+)/.exec(r.out)?.[1]);
  return hi - lo;
};

for (const film of films) {
  await check(`still ${film}`, async () => {
    const png = path.join(SMOKE, `${film}.png`);
    fs.rmSync(png, {force: true});
    const r = node('sims/capture.mjs', [film, '--size', '800x450', '--dpr', '1', '--still', '3', '--out', png]);
    if (r.code !== 0 || !fs.existsSync(png)) throw new Error(tail(r.out));
    const range = lumaRange(png);
    if (!(range > 40)) throw new Error(`frame looks blank (luma range ${range})`);
    return `luma range ${range}`;
  });
}

const clip = path.join(SMOKE, 'encode.mp4');
await check('encode', async () => {
  fs.rmSync(clip, {force: true});
  const r = node('sims/capture.mjs', [films[0], '--size', '320x180', '--dpr', '1', '--fps', '12', '--to', '0.5', '--out', clip]);
  if (r.code !== 0 || !fs.existsSync(clip)) throw new Error(tail(r.out));
  const p = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range', '-of', 'default=nw=1', clip]);
  const field = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(p.out)?.[1];
  const got = `${field('pix_fmt')} ${field('color_range')}`;
  if (got !== 'yuv420p tv') throw new Error(`expected yuv420p tv, got ${got}`);
  return got;
});

await check('sheet', async () => {
  if (!fs.existsSync(clip)) throw new Error('needs the encode clip');
  const canary = path.join(SMOKE, 'canary');
  fs.mkdirSync(canary, {recursive: true});
  fs.writeFileSync(path.join(canary, 'keep.txt'), 'keep');
  for (const bad of [['--name', '../canary'], ['--name', '..'], ['--every', '../canary']]) {
    const r = node('sheet.mjs', ['--video', clip, ...bad, ...(bad[0] === '--name' ? ['0.1'] : [])]);
    if (r.code === 0) throw new Error(`accepted ${bad.join(' ')}`);
  }
  if (!fs.existsSync(path.join(canary, 'keep.txt'))) throw new Error('a refused --name still deleted the folder');
  const ok = node('sheet.mjs', ['--video', clip, '--name', 'smoke', '0.1', '0.3']);
  const sheet = path.join(SMOKE, 'encode_sheets', 'smoke-1.png');
  if (ok.code !== 0 || !fs.existsSync(sheet)) throw new Error(tail(ok.out));
  return /drawtext unavailable/.test(ok.out) ? 'bad names refused; note: this ffmpeg has no drawtext, tiles are unlabelled' : 'bad names refused';
});

await check('sample', async () => {
  const code = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    'from sfx import synth',
    "s = synth.sample('fs-447910-plop.ogg', dur=0.1)",
    'assert len(s) > 1000, len(s)',
    'print(len(s), synth.FFMPEG)',
  ].join('\n');
  const r = run(PYTHON, ['-I', '-c', code]);
  if (r.code !== 0) throw new Error(tail(r.out));
  return `${r.out.trim().split(' ')[0]} samples via ${r.out.trim().split(' ').slice(1).join(' ')}`;
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
