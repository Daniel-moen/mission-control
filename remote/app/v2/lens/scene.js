import { createGL } from './gl.js';

// Lens (task 0445): the scene every page floats on, in one WebGL pass.
//   • the photograph (deepest; moves most with tilt), the time set huge on
//     Home (a plane above it), depth of field and dimming per page
//   • every content pane marked [data-lens] (the first MAX on screen) drawn
//     as real glass: the rim refracts the scene inward with a slight
//     chromatic split, the body is frosted (mip LOD) and magnifies a touch,
//     the edge facing the light catches it, a soft bloom follows the finger,
//     and the pane casts a shadow on the scene
//   • legibility is enforced in the shader, not hoped for: glass darkens
//     (dark theme) or whitens (light) by how bright the scene behind it is,
//     and pages other than Home compress the scene's luminance under text
// Floating chrome (bars, sheets) is never a shader pane — it's CSS glass
// above the DOM, so nothing ever scrolls "under" shader glass.

export const MAX = 14;

const FRAG = `
uniform vec2 u_res; uniform float u_px; uniform float u_time;
uniform sampler2D u_tex; uniform sampler2D u_type;
uniform vec4 u_rects[${MAX}]; uniform vec4 u_meta[${MAX}]; uniform float u_alpha[${MAX}]; uniform float u_count;
uniform vec2 u_light; uniform vec2 u_tilt; uniform float u_dof; uniform float u_dim; uniform float u_touch; uniform float u_typeA; uniform float u_theme;

float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 nRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  vec2 s = sign(p + 1e-4);
  if (q.x > 0.0 && q.y > 0.0) return normalize(q) * s;
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}
float lumOf(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// the photo + the type plane, at screen uv (y down)
vec3 scene(vec2 uv, float lod){
  vec2 pu = (uv - 0.5) / 1.1 + 0.5 - u_tilt * 0.022;
  vec3 c = texture2D(u_tex, vec2(pu.x, 1.0 - pu.y), lod).rgb;
  vec2 tu = (uv - 0.5) / 1.03 + 0.5 - u_tilt * 0.009;
  float t = texture2D(u_type, vec2(tu.x, 1.0 - tu.y), lod * 0.8).a * u_typeA;
  return mix(c, mix(vec3(1.0), vec3(0.07, 0.07, 0.08), u_theme), t);
}
// the page's treatment of the open scene: dim/wash + luminance ceiling
vec3 grade(vec3 c, vec2 uv){
  if (u_theme < 0.5) {
    float v = smoothstep(1.3, 0.2, length((uv - vec2(0.5, 0.45)) * vec2(1.0, 1.15)));
    c *= mix(0.55, 1.0, v) * (1.0 - 0.35 * u_dim);
    float l = lumOf(c);
    float ceil_ = mix(0.75, 0.12, u_dim);
    c *= mix(1.0, ceil_ / max(l, 1e-3), smoothstep(ceil_, ceil_ + 0.35, l));
  } else {
    c = mix(c, vec3(0.93, 0.925, 0.91), 0.32 + 0.5 * u_dim);
    float l = lumOf(c);
    c = mix(c, vec3(0.95, 0.945, 0.93), smoothstep(0.86, 0.45, l) * u_dim * 0.92);
  }
  return c;
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, u_res.y * u_px - gl_FragCoord.y) / u_px; // CSS px, y down
  vec2 uv = f / u_res;
  vec3 col = grade(scene(uv, u_dof), uv);

  float sh = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h + vec2(u_tilt.x * -10.0 * M.w, 14.0 + u_tilt.y * -8.0 * M.w);
    float d = sdRound(f - c, h, M.x);
    sh = max(sh, (1.0 - smoothstep(-22.0, 42.0, d)) * (0.45 - 0.25 * u_theme) * M.w * u_alpha[i]);
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
    float l = lumOf(g);
    if (u_theme < 0.5) {
      // smoked glass; never brighter than text can bear
      g = mix(g, vec3(0.05, 0.05, 0.06), 0.3 + 0.12 * e);
      g *= mix(1.0, 0.15 / max(lumOf(g), 1e-3), smoothstep(0.15, 0.45, lumOf(g)));
    } else {
      g = mix(g, vec3(0.985, 0.98, 0.97), 0.58 + 0.12 * e);
      g = mix(g, vec3(1.0), smoothstep(0.86, 0.6, lumOf(g)) * 0.7);
    }
    vec2 L = normalize(u_light - c + 1e-3);
    float facing = max(0.0, dot(n, L));
    float rim = (1.0 - smoothstep(0.0, 1.5, -d)) * (0.16 + 0.84 * facing);
    float bevel = (1.0 - smoothstep(0.0, 12.0, -d)) * (0.04 + 0.08 * facing);
    float spec = exp(-pow(length(f - u_light) / (170.0 + 120.0 * u_touch), 2.0)) * (0.04 + 0.11 * u_touch);
    vec3 rimC = mix(vec3(1.0), vec3(1.0, 0.72, 0.26), M.z);
    float rimK = u_theme < 0.5 ? 0.6 : 0.9;
    g += rimC * (rim * rimK + bevel) * (u_theme < 0.5 ? 1.0 : 0.5) + spec * (1.0 - 0.6 * u_theme);
    if (u_theme > 0.5) g -= (1.0 - smoothstep(0.0, 1.2, -d)) * (1.0 - facing) * 0.12; // a hairline of shade on the dark side
    g += vec3(0.14, 0.09, 0.02) * M.z * (0.5 + 0.5 * sin(u_time * 2.2)) * (1.0 - e) * 0.6;
    col = mix(col, g, a);
  }
  float nz = fract(sin(dot(gl_FragCoord.xy + u_time, vec2(12.9898, 78.233))) * 43758.5453);
  col += (nz - 0.5) / 255.0 * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const pot = (n) => 2 ** Math.round(Math.log2(n));

// An image "cover"-fitted for the screen's aspect into a power-of-two square
// (sampled with screen uv it's undistorted; POT lets WebGL 1 mipmap = frost).
export function photoCanvas(img, W, H) {
  const s = Math.min(2048, pot(Math.max(W, H) * 1.2));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  const ar = W / H;
  const ir = img.width / img.height;
  let sw = img.width;
  let sh = img.height;
  if (ir > ar) sw = img.height * ar;
  else sh = img.width / ar;
  x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, s, s);
  return c;
}
export function fallbackCanvas(dark = true) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(330, 300, 10, 260, 260, 420);
  if (dark) {
    g.addColorStop(0, '#b8743a');
    g.addColorStop(0.3, '#4a2a28');
    g.addColorStop(1, '#0b0a0c');
  } else {
    g.addColorStop(0, '#f2d9b8');
    g.addColorStop(1, '#c9c4bb');
  }
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  return c;
}
// The type plane: the time, huge and thin, and the date (alpha only).
export function typeCanvas(W, H, { time, date, layout }) {
  const s = Math.min(2048, pot(Math.max(W, H) * 1.4));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.scale(s / W, s / H);
  const { left, baseline, size } = layout;
  x.fillStyle = '#fff';
  x.font = `200 ${size}px "Inter Variable", -apple-system, system-ui, sans-serif`;
  x.globalAlpha = 0.92;
  x.fillText(time, left, baseline);
  x.font = `500 ${Math.max(14, size * 0.075)}px "Inter Variable", -apple-system, system-ui, sans-serif`;
  x.globalAlpha = 0.78;
  x.fillText(date, left + size * 0.04, baseline + Math.max(26, size * 0.17));
  return c;
}

export function createScene(canvas, opts) {
  return createGL(canvas, FRAG, { dprCap: 1.5, minScale: 0.5, ...opts });
}
