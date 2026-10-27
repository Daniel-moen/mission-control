import { createGL } from '../v2/lens/gl.js';

// v5.3 (task 0502): v4/v5's Lens shader with two additions, nothing else
// changed underneath:
//   • the moving light is IN the scene: three soft lights (ambient.js) mixed
//     into the photo, so every pane's rim bends them, its frosted body
//     carries their colour, and they drift behind the glass — content
//     visibly bending, not a tint laid on top
//   • u_flow: how fast something is scrolling. The light leans with it
//     (Scene.jsx moves u_light) and the rims catch more of it while it
//     moves — a specular that answers scroll as well as tilt and touch

// v4 (task 0448): the Lens scene (0445, v2/lens) under all three v4
// directions — same runner (gl.js), same photo fitting, same glass shader:
//   • the photograph full-bleed, the time set huge on it (a type plane)
//   • every pane in PANES (the first MAX on screen) drawn as real glass:
//     refracting rim with a chromatic split, frosted body (mip LOD), the edge
//     facing the light catches it, a soft shadow on the scene, amber glow on
//     what needs Daniel
// Differences from v2's shader, on purpose:
//   • light theme is a bright daytime photo under WHITE frosted glass — the
//     scene is lifted, not washed toward grey; dark keeps Lens's smoked glass
//   • glass saturates what's behind it (like backdrop saturate()), so the
//     photo's colour shows through every pane
//   • "focus" (something open full-screen) dims far less than v2's inner
//     pages: the photo stays visible; legibility is the panes' job
// 0458 — the glass bends the photo (Liquid-Glass style), not just blurs it:
//   • each pane is a slab with a convex rim: a band in from the edge (from
//     its rounded-rect SDF, thicker at the corners) samples the photo from
//     further in along a dome's slope — the photo visibly warps round the
//     edge — with an RGB split, less frost and more of the photo's light
//   • the flat body magnifies the photo a little and stays frosted + toned
//     for text (the rim band is narrow enough that text sits on the body)
//   • a bright specular line where the edge faces the light, a fainter one
//     opposite, a sheen on the steep part of the dome
//   • the bend shifts with tilt / pointer and leans against the pane's own
//     motion (u_dyn: velocity per pane, growth while it opens / flies in)
//   • u_q = 0 (the runner at its lowest resolution) drops the RGB split

export const MAX = 14;
export const PANES = '[data-lens], .st-card, .at-room-glass, .nw-card';
export const AMBER = '[data-amber], .st-card-need, .nw-hot, .at-room-needs .at-room-glass';
// never shader glass: full-screen sheets/windows and floating chrome keep CSS
// glass with a real backdrop blur (a pane must never scroll "under" another)
export const NO = '[data-no-lens], .st-open-wrap, .st-thread-wrap, .at-window, .nw-sheet-wrap, .v4-switch';

const FRAG = `
uniform vec2 u_res; uniform float u_px; uniform float u_time;
uniform sampler2D u_tex; uniform sampler2D u_type;
uniform vec4 u_rects[${MAX}]; uniform vec4 u_meta[${MAX}]; uniform vec4 u_dyn[${MAX}]; uniform float u_count; uniform float u_q;
uniform vec2 u_light; uniform vec2 u_tilt; uniform float u_dof; uniform float u_dim; uniform float u_touch; uniform float u_typeA; uniform float u_theme; uniform vec2 u_typeOff;
uniform vec4 u_amb[3]; uniform vec4 u_ambC[3]; uniform float u_flow; uniform float u_lodK;

float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 nRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  vec2 s = sign(p + 1e-4);
  if (q.x > 0.0 && q.y > 0.0) return normalize(q) * s;
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}
float lumOf(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sat(vec3 c, float k){ return max(mix(vec3(lumOf(c)), c, k), 0.0); }
vec3 scene(vec2 uv, float lod){
  vec2 pu = (uv - 0.5) / 1.1 + 0.5 - u_tilt * 0.022;
  vec3 c = texture2D(u_tex, vec2(pu.x, 1.0 - pu.y), lod).rgb;
  vec2 tu = (uv - u_typeOff / u_res - 0.5) / 1.03 + 0.5 - u_tilt * 0.009;
  float t = texture2D(u_type, vec2(tu.x, 1.0 - tu.y), lod * 0.8).a * u_typeA;
  c = mix(c, mix(vec3(1.0), vec3(0.08, 0.075, 0.07), u_theme), t);
  // the moving light: soft round lights, screened into the dark photo,
  // a colour wash over the daylight one
  vec2 px = uv * u_res - u_tilt * 6.0;
  for (int j = 0; j < 3; j++) {
    vec4 A = u_amb[j];
    vec2 dd = (px - A.xy) / max(A.z, 1.0);
    float w = exp(-dot(dd, dd) * 2.2) * A.w;
    vec3 lc = u_ambC[j].rgb;
    if (u_theme < 0.5) c = 1.0 - (1.0 - c) * (1.0 - lc * w);
    else c = mix(c, c * (0.62 + lc * 0.7), w);
  }
  return c;
}
vec3 grade(vec3 c, vec2 uv){
  if (u_theme < 0.5) {
    float v = smoothstep(1.3, 0.2, length((uv - vec2(0.5, 0.45)) * vec2(1.0, 1.15)));
    c = sat(c, 1.12) * mix(0.62, 1.0, v) * (1.0 - 0.3 * u_dim);
    float l = lumOf(c);
    float ceil_ = mix(0.78, 0.36, u_dim);
    c *= mix(1.0, ceil_ / max(l, 1e-3), smoothstep(ceil_, ceil_ + 0.35, l));
  } else {
    c = sat(c, 1.1) * (1.08 - 0.04 * u_dim);
    c = mix(c, vec3(0.975, 0.97, 0.96), 0.05 + 0.4 * u_dim);
  }
  return c;
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, u_res.y * u_px - gl_FragCoord.y) / u_px;
  vec2 uv = f / u_res;
  vec3 col = grade(scene(uv, u_dof + u_lodK * min(u_dof, 1.0)), uv);

  float sh = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h + vec2(u_tilt.x * -10.0 * M.w, 14.0 + u_tilt.y * -8.0 * M.w);
    float d = sdRound(f - c, h, M.x);
    sh = max(sh, (1.0 - smoothstep(-22.0, 42.0, d)) * (0.45 - 0.3 * u_theme) * M.w * u_dyn[i].z);
  }
  col *= 1.0 - sh;

  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i]; vec4 D = u_dyn[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h; vec2 p = f - c;
    if (abs(p.x) > h.x + 2.0 || abs(p.y) > h.y + 2.0) continue;
    float d = sdRound(p, h, M.x);
    // the edge's anti-aliasing: ~1.5 canvas px (task 0503; it was 1.4 CSS px,
    // four device px of blur round every pane on a 3× screen)
    float a = (1.0 - smoothstep(-0.9 / u_px, 0.6 / u_px, d)) * D.z;
    if (a <= 0.0) continue;

    // ---- the lens (0458): a convex rim, thicker at the corners ----------
    // band: how far in from the edge the glass curves (narrow panes → narrow
    // band, so text that starts ~12 px in sits on the flat body)
    float w0 = clamp(min(h.x, h.y) * 0.25, 10.0, 28.0);
    vec2 q = abs(p) - h + M.x;
    float corner = clamp(min(q.x, q.y) / max(M.x, 1.0), 0.0, 1.0);
    float w = w0 * (1.0 + 0.75 * corner);
    // smooth normal: the SDF of the same pane with a radius ≥ the band, so
    // the bend has no seam on the corner diagonals
    float R2 = max(M.x, w * 1.25);
    vec2 n = nRound(p, h, min(R2, min(h.x, h.y)));
    float t = clamp(1.0 + d / w, 0.0, 1.0);        // 0 inside the band → 1 at the edge
    // a dome's profile, steep at the rim but capped short of vertical (a
    // vertical slope squeezes the photo into sparkle)
    float tt = t * 0.93;
    float dome = (1.0 - sqrt(1.0 - tt * tt)) / 0.632;
    float clear = smoothstep(0.35, 0.8, t);         // outer band: little frost, the bend shows
    // where it samples: from further in (the photo bends round the rim),
    // the body magnified a little; tilt and the pane's own motion shift the
    // bend so it reads as a thick piece of glass, not a sticker
    vec2 tilt = u_tilt * vec2(-1.0, -1.0);
    vec2 vel = D.xy;
    float amp = w * 1.75 + 6.0;
    vec2 offPx = -n * dome * amp + (tilt * 9.0 - vel * 0.9) * (0.25 + dome);
    float mag = 0.075 + clamp(D.w, -0.4, 0.4) * 0.35;
    vec2 bodyPx = -p * mag + tilt * 5.0;
    vec2 base = uv + bodyPx / u_res;
    vec2 off = offPx / u_res;
    float lod = mix(3.6 + M.y + u_dof * 0.4, 1.3 + u_dof * 0.3, clear) + u_lodK;
    vec3 g;
    // (uniform branch only: a texture read under a per-pixel branch gets
    // undefined mip derivatives → seams and sparkle)
    if (u_q > 0.5) {
      // chromatic split along the bend: red bends least, blue most
      vec2 ca = n * dome * (1.2 + 0.035 * amp) / u_res;
      g.r = scene(base + off * 0.93 + ca, lod).r;
      g.g = scene(base + off, lod).g;
      g.b = scene(base + off * 1.07 - ca, lod).b;
    } else {
      g = scene(base + off, lod);
    }
    g = sat(g, mix(1.55, 1.3, clear));
    if (u_theme < 0.5) {
      // smoked glass, the photo's colour through it; never brighter than text
      // can bear on the body — the rim may carry more of the photo
      g = mix(g, vec3(0.05, 0.05, 0.06), mix(0.24, 0.08, clear));
      float ceil_ = mix(0.17, 0.5, clear);
      g *= mix(1.0, ceil_ / max(lumOf(g), 1e-3), smoothstep(ceil_, ceil_ + 0.33, lumOf(g)));
    } else {
      // white frosted glass: the photo tints it, it never goes grey; the rim
      // shows the bent photo through a thinner frost
      g = mix(g, vec3(0.995, 0.99, 0.985), mix(0.62, 0.12, clear));
      g = mix(g, vec3(1.0), smoothstep(0.9, 0.62, lumOf(g)) * 0.65 * (1.0 - clear));
    }

    // ---- light: a bright rim where the edge faces the light, a fainter one
    // opposite (light passing through), and a sheen where the dome is steep
    vec2 L = normalize(u_light - c + 1e-3);
    float facing = max(0.0, dot(n, L));
    float back = max(0.0, -dot(n, L));
    float line = 1.0 - smoothstep(0.0, 1.6, -d);
    float fl = min(abs(u_flow), 1.0);
    float rim = line * (0.22 + 1.1 * facing * facing + 0.45 * back * back) * (1.0 + 0.5 * fl);
    float sheen = pow(t, 5.0) * (0.05 + 0.28 * facing + 0.1 * back) * (1.0 + 1.4 * fl);

    float spec = exp(-pow(length(f - u_light) / (170.0 + 120.0 * u_touch), 2.0)) * (0.04 + 0.11 * u_touch);
    vec3 rimC = mix(vec3(1.0), vec3(1.0, 0.72, 0.26), M.z);
    float k = u_theme < 0.5 ? 1.0 : 0.7;
    g += rimC * (rim * (u_theme < 0.5 ? 0.62 : 0.9) + sheen) * k + spec * (1.0 - 0.6 * u_theme);
    if (u_theme > 0.5) g -= line * (1.0 - facing) * 0.12 + pow(t, 3.0) * (1.0 - facing) * 0.06;
    if (u_theme > 0.5) g = mix(g, vec3(1.0, 0.86, 0.6), M.z * (1.0 - t) * 0.3);
    g += vec3(0.14, 0.09, 0.02) * M.z * (0.5 + 0.5 * sin(u_time * 2.2)) * (1.0 - t) * 0.6;
    col = mix(col, g, a);
  }
  float nz = fract(sin(dot(gl_FragCoord.xy + u_time, vec2(12.9898, 78.233))) * 43758.5453);
  col += (nz - 0.5) / 255.0 * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const pot = (n) => 2 ** Math.round(Math.log2(n));

// The type plane: the time huge and thin, the date under it — drawn exactly
// where the direction's <LensClock> laid them out (alpha only). When the
// clock only moves (a scrolling feed), u_typeOff shifts it — no redraw.
export function typeCanvas(W, H, { time, date, t, d }) {
  const s = Math.min(2048, pot(Math.max(W, H) * 1.4));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.scale(s / W, s / H);
  x.fillStyle = '#fff';
  const fam = '-apple-system, "SF Pro Display", "Inter Variable", system-ui, sans-serif';
  if (t) {
    x.font = `200 ${t.size}px ${fam}`;
    x.globalAlpha = 0.92;
    x.letterSpacing = `${(-0.04 * t.size).toFixed(1)}px`;
    x.fillText(time, t.x, t.y);
  }
  if (d) {
    x.letterSpacing = '0px';
    x.font = `500 ${d.size}px ${fam}`;
    x.globalAlpha = 0.82;
    x.fillText(date, d.x, d.y);
  }
  return c;
}

// Resolution (task 0503). Daniel, on an iPhone: "the liquid glass it seems a
// bit like low res". It was: the canvas rendered at 1.5 device px per CSS px
// (an iPhone has 3, so every rim was upscaled 2×), a busy spell could drop it
// to 0.75 for good (gl.js's recovery needed a 120 Hz screen), and the photo
// was a 1024² texture stretched over a 2532-px-tall screen.
//   • up to 2 device px per CSS px: the rims are anti-aliased in CSS px, so
//     2× reads as crisp on a 3× screen, at 44% of 3×'s fragment cost
//   • the adaptive floor is 1.5 (what every frame used to be), and it climbs
//     back once frames make vsync again at 60 Hz (calmDt/streak, gl.js)
//   • the frost is a mip-LOD bias, so its blur is measured in canvas pixels:
//     u_lodK (Scene.jsx) adds log2(px / 1.5) so it stays the same in CSS px
export const DPR_CAP = 2;
export function createScene(canvas, opts) {
  return createGL(canvas, FRAG, { dprCap: DPR_CAP, minScale: 0.75, calmDt: 18.5, calmN: 120, streak: true, ...opts });
}

// The photograph at the screen's resolution (task 0503): a power-of-two
// texture per axis (WebGL 1 mipmaps), sized to the canvas's device pixels
// (≤ 2048 per side), the photo cropped to the screen's aspect. v4/v5 used one
// square sized to CSS px — half the detail on a 3× screen.
const ceilPot = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
export function photoTexture(img, W, H, px, max = 2048) {
  const tw = Math.min(max, ceilPot(W * px));
  const th = Math.min(max, ceilPot(H * px));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const ar = W / H;
  const ir = img.width / img.height;
  let sw = img.width;
  let sh = img.height;
  if (ir > ar) sw = img.height * ar;
  else sh = img.width / ar;
  x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, tw, th);
  return c;
}
