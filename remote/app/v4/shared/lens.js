import { createGL } from '../../v2/lens/gl.js';

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

export const MAX = 14;
export const PANES = '[data-lens], .st-card, .at-room-glass, .nw-card';
export const AMBER = '[data-amber], .st-card-need, .nw-hot, .at-room-needs .at-room-glass';
// never shader glass: full-screen sheets/windows and floating chrome keep CSS
// glass with a real backdrop blur (a pane must never scroll "under" another)
export const NO = '[data-no-lens], .st-open-wrap, .st-thread-wrap, .at-window, .nw-sheet-wrap, .v4-switch';

const FRAG = `
uniform vec2 u_res; uniform float u_px; uniform float u_time;
uniform sampler2D u_tex; uniform sampler2D u_type;
uniform vec4 u_rects[${MAX}]; uniform vec4 u_meta[${MAX}]; uniform float u_alpha[${MAX}]; uniform float u_count;
uniform vec2 u_light; uniform vec2 u_tilt; uniform float u_dof; uniform float u_dim; uniform float u_touch; uniform float u_typeA; uniform float u_theme; uniform vec2 u_typeOff;

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
  return mix(c, mix(vec3(1.0), vec3(0.08, 0.075, 0.07), u_theme), t);
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
  vec3 col = grade(scene(uv, u_dof), uv);

  float sh = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h + vec2(u_tilt.x * -10.0 * M.w, 14.0 + u_tilt.y * -8.0 * M.w);
    float d = sdRound(f - c, h, M.x);
    sh = max(sh, (1.0 - smoothstep(-22.0, 42.0, d)) * (0.45 - 0.3 * u_theme) * M.w * u_alpha[i]);
  }
  col *= 1.0 - sh;

  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h; vec2 p = f - c;
    if (abs(p.x) > h.x + 2.0 || abs(p.y) > h.y + 2.0) continue;
    float d = sdRound(p, h, M.x);
    float a = (1.0 - smoothstep(-0.8, 0.6, d)) * u_alpha[i];
    if (a <= 0.0) continue;
    vec2 n = nRound(p, h, M.x);
    float e = clamp(-d / 24.0, 0.0, 1.0);
    float bend = pow(1.0 - e, 2.2);
    vec2 off = -n * bend * 26.0 / u_res;
    vec2 lens = -(p / u_res) * 0.06;
    float lod = 3.6 + M.y + u_dof * 0.4;
    vec3 g;
    g.r = scene(uv + lens + off * 0.9, lod).r;
    g.g = scene(uv + lens + off * 1.15, lod).g;
    g.b = scene(uv + lens + off * 1.4, lod).b;
    g = sat(g, 1.55);
    if (u_theme < 0.5) {
      // smoked glass, the photo's colour through it; never brighter than text can bear
      g = mix(g, vec3(0.05, 0.05, 0.06), 0.24 + 0.12 * e);
      g *= mix(1.0, 0.17 / max(lumOf(g), 1e-3), smoothstep(0.17, 0.5, lumOf(g)));
    } else {
      // white frosted glass: the photo tints it, it never goes grey
      g = mix(g, vec3(0.995, 0.99, 0.985), 0.6 + 0.1 * e);
      g = mix(g, vec3(1.0), smoothstep(0.9, 0.62, lumOf(g)) * 0.65);
    }
    vec2 L = normalize(u_light - c + 1e-3);
    float facing = max(0.0, dot(n, L));
    float rim = (1.0 - smoothstep(0.0, 1.5, -d)) * (0.16 + 0.84 * facing);
    float bevel = (1.0 - smoothstep(0.0, 12.0, -d)) * (0.04 + 0.08 * facing);
    float spec = exp(-pow(length(f - u_light) / (170.0 + 120.0 * u_touch), 2.0)) * (0.04 + 0.11 * u_touch);
    vec3 rimC = mix(vec3(1.0), vec3(1.0, 0.72, 0.26), M.z);
    float rimK = u_theme < 0.5 ? 0.6 : 0.9;
    g += rimC * (rim * rimK + bevel) * (u_theme < 0.5 ? 1.0 : 0.5) + spec * (1.0 - 0.6 * u_theme);
    if (u_theme > 0.5) g -= (1.0 - smoothstep(0.0, 1.2, -d)) * (1.0 - facing) * 0.1;
    if (u_theme > 0.5) g = mix(g, vec3(1.0, 0.86, 0.6), M.z * (1.0 - e) * 0.35);
    g += vec3(0.14, 0.09, 0.02) * M.z * (0.5 + 0.5 * sin(u_time * 2.2)) * (1.0 - e) * 0.6;
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

export function createScene(canvas, opts) {
  return createGL(canvas, FRAG, { dprCap: 1.5, minScale: 0.5, ...opts });
}
