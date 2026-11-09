// Render the v6.4 backdrops (scenes.mjs) to public/bg6/*.webp + manifest.json.
// node tools/backdrops/render.mjs [only-file]   (needs playwright + cwebp)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON, SCENES } from './scenes.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || `${os.homedir()}/PropIQ-design-0225/node_modules/playwright`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'public', 'bg6');
const SIZE = 2048, TARGET = 300 * 1024;
const only = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg6-'));

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setContent('<canvas id=c></canvas>');
for (const s of SCENES) {
  if (only && s.file !== only) continue;
  const png = await page.evaluate(({ src, size }) => {
    const cv = document.getElementById('c');
    cv.width = cv.height = size;
    const gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    const sh = (t, code) => { const o = gl.createShader(t); gl.shaderSource(o, code); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, src));
    gl.linkProgram(p);
    gl.useProgram(p);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, size, size);
    gl.uniform2f(gl.getUniformLocation(p, 'R'), size, size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return cv.toDataURL('image/png');
  }, { src: COMMON + s.frag, size: SIZE });
  const pngFile = path.join(tmp, s.file.replace('.webp', '.png'));
  fs.writeFileSync(pngFile, Buffer.from(png.split(',')[1], 'base64'));
  // highest quality that stays near the size target
  let best = null;
  for (const q of [94, 88, 82, 76, 70, 64, 58, 52, 46, 40]) {
    const out = path.join(tmp, `${q}.webp`);
    execFileSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', '-sharp_yuv', pngFile, '-o', out]);
    const sz = fs.statSync(out).size;
    best = { out, q, sz };
    if (sz <= TARGET * 1.08) break;
  }
  fs.copyFileSync(best.out, path.join(OUT, s.file));
  console.log(`${s.file}  q${best.q}  ${(best.sz / 1024).toFixed(0)} KB`);
}
await browser.close();
const manifest = SCENES.map(({ file, tone, title, desc }) => ({ file, tone, title, desc, credit: 'Generated for Mission Control (procedural shader, tools/backdrops)', licence: 'original work, no third-party rights' }));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
