'use client';
// The Liquid Glass lens layer (v6.2). One transparent WebGL canvas floats over
// the app (under sheets) and draws, for every floating control registered as a
// lens (dock, Talk button, top pills, composers, search bar):
//   - a convex-lens edge band: the scene behind is re-rendered in the shader
//     (same photo, same drift, same liquid light, same tint) and sampled with
//     an inward displacement that grows toward the rim, so the backdrop is
//     magnified and bent at the edge, with a touch of chromatic dispersion
//   - thin specular highlights along the rim facing the light (and a weaker
//     catch on the opposite side); the light orbits slowly and turns toward the
//     finger/pointer or the device tilt
//   - liquid merging: shapes are combined with a smooth-min SDF, so when two
//     controls come close (the Talk button blooming out of the dock) they join
//     and split like drops
//   - press: the lens bends harder and lights up
// The middle of each control is plain CSS glass (backdrop blur of whatever
// DOM is underneath), so content scrolling beneath stays visible.
// Works in WebKit (no SVG filters needed). Falls back to CSS-only glass when
// WebGL is missing, the context is lost, or 'calm' is on.

import { useEffect, useRef } from 'react';
import { LIQUID_GLSL } from './Liquid';
import { paint, activePane, type Snapshot } from '@/lib/raster';
import { TINT, energy, lenses, light, lightDir, lumMap, photoMap, scene, sceneTime, setGlActive } from '@/lib/glass';

const MAX = 12;

const VERT = `
attribute vec2 a; uniform vec2 uView;
void main(){ vec2 c = a / uView * 2. - 1.; gl_Position = vec4(c.x, -c.y, 0., 1.); }`;

const FRAG = `
precision highp float;
uniform vec2 uView; uniform float uDpr; uniform int uN;
uniform vec4 uS[${MAX}]; uniform vec4 uP[${MAX}]; uniform float uQ[${MAX}];
uniform vec2 uL; uniform float uT; uniform float uE;
uniform float uPhoto; uniform vec4 uPA; uniform vec4 uTint; uniform sampler2D uImg; uniform vec2 uEdge;
uniform sampler2D uC; uniform vec3 uCM;
${LIQUID_GLSL}
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float smin(float a, float b, float k){ float h = clamp(.5 + .5*(b - a)/k, 0., 1.); return mix(b, a, h) - k*h*(1. - h); }
float field(vec2 p){
  float d = 1e5;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uN) break;
    vec4 s = uS[i];
    d = smin(d, sdBox(p - s.xy, s.zw, min(uP[i].x, min(s.z, s.w))), 10.);
  }
  return d;
}
vec3 tint(vec3 c, vec2 uv){
  c = mix(c, vec3(.047, .043, .055), mix(uTint.z, uTint.w, uv.y));
  float r = length(vec2((uv.x - .5) / 1.2, uv.y / .8));
  return mix(c, vec3(.047, .043, .055), mix(uTint.x, uTint.y, clamp(r / .7, 0., 1.)));
}
// the pane content (cards, text) painted into a 3-screen-tall window; uCM = (scroll since paint, window top offset H, on)
vec4 contentAt(vec2 p){ vec2 c = vec2(p.x / uView.x, (p.y + uCM.x + uCM.y) / (3. * uCM.y)); if (uCM.z < .5 || c.y < 0. || c.y > 1.) return vec4(0.); return texture2D(uC, c); }
vec3 over(vec3 bg, vec4 c){ return bg * (1. - c.a) + c.rgb; }
vec3 photoAt(vec2 p, float bias){ return texture2D(uImg, clamp(p * uPA.xy + uPA.zw, 0., 1.), bias).rgb; }
void main(){
  vec2 p = vec2(gl_FragCoord.x, uView.y * uDpr - gl_FragCoord.y) / uDpr;
  // nearest shape's parameters
  float best = 1e5; vec4 S = vec4(0.); vec4 P = vec4(0.); float Q = 0.;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uN) break;
    float di = sdBox(p - uS[i].xy, uS[i].zw, min(uP[i].x, min(uS[i].z, uS[i].w)));
    if (di < best) { best = di; S = uS[i]; P = uP[i]; Q = uQ[i]; }
  }
  float d = field(p);
  float cov = clamp(.5 - d * uDpr, 0., 1.);
  if (cov <= 0.) discard;
  vec2 g = vec2(field(p + vec2(1., 0.)) - field(p - vec2(1., 0.)), field(p + vec2(0., 1.)) - field(p - vec2(0., 1.)));
  vec2 n = length(g) > 1e-4 ? normalize(g) : vec2(0., -1.);
  float press = P.z;
  float w = clamp(min(S.z, S.w) * .62, 8., 22.);
  float depth = max(-d, 0.);
  float x = clamp(depth / w, 0., 1.);
  // v6.3 convex rim: sample from deeper inside, compressed toward the edge, so
  // the band MAGNIFIES what's under the control (ds/dd ~ .1 at the rim, 1 inside)
  // and bends it around the corners; R/G/B bend by different amounts (fringe)
  float bend = (1. - x) * (1. - x);
  float kk = .44 + .05 * press;
  vec2 pr = p - n * bend * w * (kk - .05);
  vec2 ps = p - n * bend * w * kk;
  vec2 pb = p - n * bend * w * (kk + .05);
  float bias = 1.2 + 1.6 * bend;
  vec3 col;
  vec3 liq = liquid(vec2(ps.x / uView.x, 1. - ps.y / uView.y), uView, uT, uE, uPhoto);
  if (uPhoto > .5) {
    vec3 ph = vec3(photoAt(pr, bias).r, photoAt(ps, bias).g, photoAt(pb, bias).b);
    col = ph + .9 * liq * (1. - ph);
  } else {
    col = liq;
  }
  vec4 cr = contentAt(pr) * Q, cg = contentAt(ps) * Q, cb = contentAt(pb) * Q;
  col = vec3(over(vec3(col.r), cr).r, over(vec3(col.g), cg).g, over(vec3(col.b), cb).b);
  col = tint(col, ps / uView);
  // the scroll-edge dimming under the dock (matches .edge-bottom)
  if (uEdge.y > 0.) {
    float f = clamp((ps.y - uEdge.x) / uEdge.y, 0., 1.);
    float ga = f < .45 ? .2 * f / .45 : .2 + .14 * (f - .45) / .55;
    col = mix(col, vec3(.047, .043, .055), ga * clamp(f / .4, 0., 1.));
  }
  // glass body: a little lift, lighter at the rim; adaptive dim when the backdrop is bright
  col = mix(col, vec3(1.), .04 + .08 * bend);
  col *= 1. - .3 * P.w;
  // specular rim, facing the light, plus a weaker catch opposite
  float f1 = max(dot(n, uL), 0.), f2 = max(dot(n, -uL), 0.);
  float line = exp(-depth * depth / 1.1) * (.3 + 1.25 * pow(f1, 3.) + .6 * pow(f2, 3.));
  float glow = (1. - x) * (1. - x) * (.16 * pow(f1, 2.) + .06 * pow(f2, 2.));
  vec3 lit = vec3(1., .98, .96) * (line + glow) * (1. + .8 * press);
  float a = (1. - smoothstep(.55, 1., x)) * .96;
  // pressed: the whole lens lights up a little
  float wash = press * .14;
  float alpha = clamp(a + wash, 0., 1.);
  vec3 pre = col * a + vec3(1.) * wash + lit;
  gl_FragColor = vec4(min(pre, vec3(1.)), max(alpha, min(1., line))) * cov * P.y;
}`;

interface Live { fl: number; x: number; y: number; w: number; h: number; r: number; o: number; press: number; dim: number }

function paneOpacity(el: HTMLElement): number {
  let o = 1;
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const st = n.style;
    if (st.visibility === 'hidden' || st.display === 'none') return 0;
    if (st.opacity) o *= parseFloat(st.opacity);
    if (n.classList.contains('pane') && n.getAttribute('aria-hidden') === 'true' && !st.opacity) return 0;
    if (o < 0.01) return 0;
  }
  return o;
}

function sceneLum(cx: number, cy: number, W: number, H: number, pa: number[]): number {
  const tnt = scene.mode === 'gradient' ? TINT.gradient : TINT.photo;
  let base = 0.18;
  if (scene.mode === 'photo' && lumMap.data && pa[0]) {
    const u = Math.min(0.999, Math.max(0, cx * pa[0] + pa[2]));
    const v = Math.min(0.999, Math.max(0, cy * pa[1] + pa[3]));
    base = lumMap.data[Math.floor(v * lumMap.h) * lumMap.w + Math.floor(u * lumMap.w)] * 0.9 + 0.06;
  }
  const lin = tnt[2] + (tnt[3] - tnt[2]) * (cy / H);
  const r = Math.hypot((cx / W - 0.5) / 1.2, cy / H / 0.8);
  const rad = tnt[0] + (tnt[1] - tnt[0]) * Math.min(1, r / 0.7);
  return base * (1 - lin) * (1 - rad);
}

export function GlassLayer() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'default' });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[glass]', gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    const uView = U('uView'), uDpr = U('uDpr'), uN = U('uN'), uS = U('uS'), uP = U('uP'), uL = U('uL'), uT = U('uT'), uE = U('uE'), uPhoto = U('uPhoto'), uPA = U('uPA'), uTint = U('uTint'), uEdge = U('uEdge'), uQ = U('uQ'), uC = U('uC'), uCM = U('uCM');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // photo texture: power-of-two copy so it can be mip-mapped (soft refraction)
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 18, 24, 255]));
    let texV = -1;
    const upload = () => {
      texV = scene.v;
      const img = scene.img;
      if (!img) return;
      const c = document.createElement('canvas');
      c.width = c.height = 1024;
      c.getContext('2d')!.drawImage(img, 0, 0, 1024, 1024);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };

    // content texture (unit 1)
    const ctex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ctex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    for (const [k2, v2] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k2, v2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(U('uImg'), 0);
    gl.uniform1i(uC, 1);
    const maxTex = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
    let snap: Snapshot | null = null, snapV = -1, dirty = true, dirtyAt = 0, lastPaint = 0, lastPane: HTMLElement | null = null, scrollAt = 0;
    const markDirty = (delay = 0) => { dirty = true; dirtyAt = Math.max(dirtyAt, performance.now() + delay); };
    const onScroll = () => { scrollAt = performance.now(); };
    addEventListener('scroll', onScroll, { capture: true, passive: true });
    const mo = new MutationObserver(() => markDirty(250));
    const app = document.querySelector('.app') || document.body;
    mo.observe(app, { childList: true, subtree: true, characterData: true });
    (window as any).__mcContent = () => snap && { v: snap.v, k: snap.k, w: snap.canvas.width, h: snap.canvas.height, data: snap.canvas.toDataURL('image/png') };
    const contentTick = (now: number) => {
      const pane = activePane();
      if (pane !== lastPane) { lastPane = pane; markDirty(380); }
      if (snap && pane && snap.pane === pane) {
        const dy = pane.scrollTop - snap.scroll;
        if (Math.abs(dy) > snap.H * 0.7) markDirty();
        else if (now - scrollAt > 140 && dy !== 0) markDirty();
      }
      if (snap && Math.abs(innerHeight - snap.H) > 1) markDirty();
      if (dirty && now >= dirtyAt && now - lastPaint > 120) {
        dirty = false;
        lastPaint = now;
        snap = paint(snap, maxTex);
      }
      if (snap && snap.v !== snapV) {
        snapV = snap.v;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snap.canvas);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.activeTexture(gl.TEXTURE0);
      }
      const on = !!(snap && pane && snap.pane === pane && pane.style.opacity !== '0');
      gl.uniform3f(uCM, on && pane ? pane.scrollTop - snap!.scroll : 0, snap ? snap.H : H, on ? 1 : 0);
    };

    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      W = innerWidth;
      H = innerHeight;
      dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      gl.viewport(0, 0, cv.width, cv.height);
    };
    resize();
    addEventListener('resize', resize);

    let lost = false;
    const onLost = (e: Event) => { e.preventDefault(); lost = true; setGlActive(false); };
    cv.addEventListener('webglcontextlost', onLost);
    setGlActive(true);

    const S = new Float32Array(MAX * 4), P = new Float32Array(MAX * 4), Q = new Float32Array(MAX);
    let raf = 0, last = 0, lastDim = 0, cleared = false, sig = '', still = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // 60 fps while things move (scroll, press, pointer, springs); 30 fps when still
      if (lost || document.hidden || now - last < (still > 20 && now - light.pointerAt > 1500 ? 32 : 15)) return;
      last = now;
      if (texV !== scene.v) upload();
      const t = sceneTime(now);
      const pa = photoMap(t, W, H);
      const doDim = now - lastDim > 400;
      if (doDim) lastDim = now;
      // collect visible lenses
      const live: Live[] = [];
      for (const l of lenses) {
        if (live.length >= MAX) break;
        const o = paneOpacity(l.el);
        if (o <= 0.01 || !l.el.isConnected) continue;
        const r = l.el.getBoundingClientRect();
        if (r.width < 4 || r.bottom < -20 || r.top > H + 20) continue;
        l.press += ((l.pressAt ? 1 : 0) - l.press) * 0.25;
        const sc = l.el.offsetWidth ? r.width / l.el.offsetWidth : 1;
        if (doDim || l.el.dataset.dim === undefined) {
          const lum = sceneLum(r.left + r.width / 2, r.top + r.height / 2, W, H, pa);
          const dim = Math.max(0, Math.min(1, (lum - 0.16) / 0.3));
          l.el.style.setProperty('--dim', dim.toFixed(2));
          l.el.dataset.dim = dim.toFixed(2);
        }
        live.push({ fl: l.el.closest('.pane') ? 0 : 1, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width / 2, h: r.height / 2, r: Math.min(l.radius * sc, r.width / 2, r.height / 2), o, press: l.press, dim: +(l.el.dataset.dim || 0) });
      }
      if (!live.length) {
        if (!cleared) { gl.clear(gl.COLOR_BUFFER_BIT); cleared = true; }
        return;
      }
      cleared = false;
      // quads: each lens' box + margin, overlapping boxes merged (so merged
      // shapes draw once and their liquid bridge is covered)
      const M = 14;
      let boxes = live.map((s) => [s.x - s.w - M, s.y - s.h - M, s.x + s.w + M, s.y + s.h + M]);
      for (let merged = true; merged; ) {
        merged = false;
        outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
            boxes[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            boxes.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
      const v = new Float32Array(boxes.length * 12);
      boxes.forEach(([x0, y0, x1, y1], i) => v.set([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1], i * 12));
      S.fill(0);
      Q.fill(0);
      P.fill(0);
      live.forEach((s, i) => {
        S.set([s.x, s.y, s.w, s.h], i * 4);
        P.set([s.r, s.o, s.press, s.dim], i * 4);
        Q[i] = s.fl;
      });
      const sg = live.map((q) => `${q.x | 0},${q.y | 0},${q.w | 0},${q.h | 0},${q.press > 0.01 ? 1 : 0}`).join(';');
      still = sg === sig ? still + 1 : 0;
      sig = sg;
      const L = lightDir(now, W, H);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      gl.uniform2f(uView, W, H);
      gl.uniform1f(uDpr, dpr);
      gl.uniform1i(uN, live.length);
      gl.uniform4fv(uS, S);
      gl.uniform4fv(uP, P);
      gl.uniform1fv(uQ, Q);
      gl.uniform2f(uL, L.x, L.y);
      gl.uniform1f(uT, t);
      gl.uniform1f(uE, energy.value);
      gl.uniform1f(uPhoto, scene.mode === 'photo' && scene.img ? 1 : 0);
      gl.uniform4f(uPA, pa[0], pa[1], pa[2], pa[3]);
      const tn = scene.mode === 'gradient' ? TINT.gradient : TINT.photo;
      gl.uniform4f(uTint, tn[0], tn[1], tn[2], tn[3]);
      const eb = document.querySelector('.edge-bottom');
      const er = eb ? eb.getBoundingClientRect() : null;
      gl.uniform2f(uEdge, er ? er.top : 0, er ? er.height : 0);
      contentTick(now);
      gl.drawArrays(gl.TRIANGLES, 0, boxes.length * 6);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      cv.removeEventListener('webglcontextlost', onLost);
      removeEventListener('scroll', onScroll, { capture: true } as any);
      mo.disconnect();
      setGlActive(false);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);
  return <canvas ref={ref} className="glass-layer" aria-hidden />;
}
