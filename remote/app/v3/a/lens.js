import { createGL } from '../shared/gl.js';

// Direction A — "Lens" (task 0445): the glass is real. One WebGL pass draws
// the backdrop (a photograph, and the time set huge in a layer above it) and
// every pane of glass on top: each refracts what's behind it (the rim bends
// light inward, a little chromatic split), is frosted by mipmap LOD, carries
// a rim that catches the light where its edge faces it, a specular bloom
// that follows your finger, and a soft shadow on the scene. The DOM panes
// mark themselves [data-lens]; their rects feed the shader every frame, so
// the glass follows scrolling, springs and parallax exactly.

export const MAX = 12;

const FRAG = `
uniform vec2 u_res; uniform float u_px; uniform float u_time;
uniform sampler2D u_tex; uniform sampler2D u_type;
uniform vec4 u_rects[${MAX}]; uniform vec4 u_meta[${MAX}]; uniform float u_alpha[${MAX}]; uniform float u_count;
uniform vec2 u_light; uniform vec2 u_tilt; uniform float u_dof; uniform float u_touch; uniform float u_typeA;

float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec2 nRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  vec2 s = sign(p + 1e-4);
  if (q.x > 0.0 && q.y > 0.0) return normalize(q) * s;
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}
// The scene behind the glass at screen point uv (0..1, y down): photo deep
// (moves most with tilt), type nearer.
vec3 scene(vec2 uv, float lod){
  vec2 pu = (uv - 0.5) / 1.1 + 0.5 - u_tilt * 0.022;
  vec3 c = texture2D(u_tex, vec2(pu.x, 1.0 - pu.y), lod).rgb;
  vec2 tu = (uv - 0.5) / 1.03 + 0.5 - u_tilt * 0.009;
  vec4 t = texture2D(u_type, vec2(tu.x, 1.0 - tu.y), lod * 0.8);
  return mix(c, vec3(1.0), t.a * u_typeA);
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, u_res.y * u_px - gl_FragCoord.y) / u_px; // CSS px, y down
  vec2 uv = f / u_res;
  vec3 col = scene(uv, u_dof);
  // vignette + a slow breath of light across the scene
  float v = smoothstep(1.25, 0.2, length((uv - vec2(0.5, 0.45)) * vec2(1.0, 1.15)));
  col *= mix(0.55, 1.0, v);
  col *= 0.9 + 0.1 * sin(u_time * 0.25 + uv.x * 2.0);

  // shadows the panes cast on the scene
  float sh = 0.0;
  for (int i = 0; i < ${MAX}; i++){
    if (float(i) >= u_count) break;
    vec4 R = u_rects[i]; vec4 M = u_meta[i];
    vec2 h = R.zw * 0.5; vec2 c = R.xy + h + vec2(u_tilt.x * -10.0 * M.w, 16.0 + u_tilt.y * -8.0 * M.w);
    float d = sdRound(f - c, h, M.x);
    sh = max(sh, (1.0 - smoothstep(-24.0, 46.0, d)) * 0.5 * M.w * u_alpha[i]);
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
    float e = clamp(-d / 26.0, 0.0, 1.0);
    float bend = pow(1.0 - e, 2.2);
    // refraction: the rim pulls the scene inward; the body magnifies a touch
    vec2 off = -n * bend * 30.0 / u_res;
    vec2 lens = -(p / u_res) * 0.07;
    float lod = 3.4 + M.y + u_dof * 0.5;
    vec3 g;
    g.r = scene(uv + lens + off * 0.9, lod).r;
    g.g = scene(uv + lens + off * 1.15, lod).g;
    g.b = scene(uv + lens + off * 1.4, lod).b;
    // tint: smoked glass, a little denser toward the middle for legibility
    g = mix(g, vec3(0.045, 0.045, 0.055), 0.26 + 0.16 * e);
    // light: rim where the edge faces the light, inner bevel, specular bloom
    vec2 L = normalize(u_light - c + 1e-3);
    float facing = max(0.0, dot(n, L));
    float rim = (1.0 - smoothstep(0.0, 1.6, -d)) * (0.18 + 0.82 * facing);
    float bevel = (1.0 - smoothstep(0.0, 14.0, -d)) * (0.05 + 0.1 * facing);
    float spec = exp(-pow(length(f - u_light) / (180.0 + 120.0 * u_touch), 2.0)) * (0.05 + 0.13 * u_touch);
    vec3 rimC = mix(vec3(1.0), vec3(1.0, 0.74, 0.28), M.z);
    g += rimC * (rim * 0.62 + bevel) + spec;
    // an amber pane breathes (it's waiting on you)
    g += vec3(0.16, 0.1, 0.02) * M.z * (0.5 + 0.5 * sin(u_time * 2.2)) * (1.0 - e) * 0.6;
    col = mix(col, g, a);
  }
  // film grain, so the gradients never band on an 8-bit panel
  float n = fract(sin(dot(gl_FragCoord.xy + u_time, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0 * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// Draw an image "cover" into a power-of-two canvas, stretched to the screen's
// aspect — sampled with screen uv it comes out undistorted, and POT lets
// WebGL 1 mipmap it (the frost).
function pot(n) {
  return 2 ** Math.round(Math.log2(n));
}
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
export function gradientCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(330, 300, 10, 260, 260, 420);
  g.addColorStop(0, '#d98a3a');
  g.addColorStop(0.25, '#5b2f2a');
  g.addColorStop(1, '#0b0a0c');
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  return c;
}
// The type layer: the time, huge and thin, and the date — white on clear.
export function typeCanvas(W, H, { time, date, phone }) {
  const s = Math.min(2048, pot(Math.max(W, H) * 1.4));
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  // Draw in screen space, then squash into the square texture.
  x.scale(s / W, s / H);
  const size = phone ? W * 0.44 : Math.min(H * 0.42, W * 0.25);
  x.font = `200 ${size}px "Inter Variable", -apple-system, system-ui, sans-serif`;
  x.fillStyle = '#fff';
  x.textBaseline = 'alphabetic';
  const tx = phone ? W * 0.06 : W * 0.045;
  const ty = phone ? H * 0.255 : H * 0.62;
  x.globalAlpha = 0.92;
  x.fillText(time, tx, ty);
  x.font = `500 ${phone ? 15 : 19}px "Inter Variable", -apple-system, system-ui, sans-serif`;
  x.globalAlpha = 0.75;
  x.fillText(date, tx + size * 0.04, ty + (phone ? 30 : 42));
  return c;
}

export function createLens(canvas) {
  return createGL(canvas, FRAG, { dprCap: 1.5, minScale: 0.5 });
}
