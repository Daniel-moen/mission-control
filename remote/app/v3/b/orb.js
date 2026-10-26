import { createGL } from '../shared/gl.js';

// Direction B — "Presence" (task 0445): Mia as a living thing. One fragment
// shader draws her: a sphere of slow, domain-warped liquid colour (ember,
// rose, violet, cream — no blue) whose edge breathes and ripples; lit from
// wherever your finger is; its core warms when she speaks or thinks; amber
// light rims her while something waits on you; turbulence follows how hard the
// fleet is working. The agents' orbit is drawn here too (its back half goes
// behind her), the satellites themselves are DOM.

const FRAG = `
uniform vec2 u_res; uniform float u_px; uniform float u_time;
uniform vec2 u_c; uniform float u_r;
uniform float u_energy; uniform float u_voice; uniform float u_attn; uniform float u_think; uniform float u_pulse; uniform float u_press;
uniform vec2 u_light; uniform vec2 u_tilt; uniform vec4 u_ring;

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
float fbm2(vec3 p){ return 0.62 * noise(p) + 0.38 * noise(p * 2.1 + 4.0); }

float ring(vec2 p, float front){
  if (u_ring.z <= 0.0) return 0.0;
  vec2 q = p / u_ring.xy;
  float e = abs(length(q) - 1.0) * u_ring.y;
  float side = p.y > 0.0 ? 1.0 : 0.0; // y down: lower half is nearer
  return exp(-e * e * 0.9) * u_ring.z * (front > 0.5 ? side : 1.0 - side);
}

void main(){
  vec2 f = vec2(gl_FragCoord.x, u_res.y * u_px - gl_FragCoord.y) / u_px;
  vec2 uv = f / u_res;
  vec2 c = u_c + u_tilt * vec2(14.0, 10.0);
  vec2 p = f - c;
  float t = u_time;
  // the room: near-black, warm light pooled under her
  vec3 col = vec3(0.022, 0.02, 0.026);
  col += vec3(0.05, 0.028, 0.05) * (1.0 - uv.y);
  col += vec3(0.16, 0.075, 0.05) * exp(-pow(length((p - vec2(0.0, u_r * 1.55)) / vec2(u_r * 3.4, u_r * 0.9)), 2.0)) * (0.55 + 0.45 * u_energy + u_voice);
  col += vec3(0.42, 0.62, 0.48) * ring(p, 0.0) * 0.32;

  float d = length(p);
  if (d < u_r * 2.4) {
    float ang = atan(p.y, p.x);
    float speed = 0.3 + u_energy * 0.55 + u_think * 1.1 + u_voice * 1.4;
    float breath = 1.0 + 0.028 * sin(t * 1.2) + u_voice * 0.13 + u_pulse * 0.045 - u_press * 0.04;
    float edge = fbm2(vec3(cos(ang) * 1.5, sin(ang) * 1.5, t * speed * 0.55)) - 0.5;
    float R = u_r * breath * (1.0 + edge * (0.08 + u_energy * 0.06 + u_voice * 0.3 + u_pulse * 0.08));
    // her air: a faint warm scatter just outside the skin (not a glow)
    float out_ = max(0.0, d - R);
    col += vec3(0.85, 0.45, 0.32) * 0.07 * exp(-out_ / (R * 0.22)) * step(R, d);
    if (d < R + 1.5) {
      vec2 q = p / R;
      float z = sqrt(max(0.0, 1.0 - dot(q, q)));
      vec3 n = normalize(vec3(q, z));
      vec3 sp = vec3(q / (0.7 + z * 0.6), 0.0) * 0.8;
      float tt = t * speed;
      float w1 = fbm(sp * 1.2 + vec3(0.0, tt * 0.1, tt * 0.04));
      float w2 = fbm(sp * 1.5 + vec3(w1 * 1.8, -tt * 0.08, w1));
      float m = fbm(sp * 1.1 + vec3(w2 * 2.0, w1 * 1.3, tt * 0.035));
      // fbm sits near 0.47 with little spread: stretch it to the full ramp
      float k = clamp((m - 0.2) * 2.1 + (w2 - 0.45) * 1.6, 0.0, 1.0);
      vec3 cViolet = vec3(0.34, 0.16, 0.52), cRose = vec3(0.95, 0.34, 0.46), cEmber = vec3(1.0, 0.56, 0.27), cCream = vec3(1.0, 0.9, 0.78);
      vec3 base = mix(cViolet, cRose, smoothstep(-0.1, 0.34, k));
      base = mix(base, cEmber, smoothstep(0.38, 0.72, k));
      base = mix(base, cCream, smoothstep(0.7, 1.0, k) * 0.8);
      vec3 L = normalize(vec3((u_light - c) / max(u_r * 1.8, 1.0), 1.1));
      float diff = 0.55 + 0.5 * max(0.0, dot(n, L));
      float spec = pow(max(0.0, dot(reflect(-L, n), vec3(0.0, 0.0, 1.0))), 28.0) * 0.5;
      float fres = pow(1.0 - z, 2.6);
      vec3 rimC = mix(vec3(1.0, 0.78, 0.72), vec3(1.0, 0.72, 0.25), u_attn * (0.6 + 0.4 * sin(t * 2.4)));
      vec3 orb = base * diff * (0.85 + 0.3 * w1) + spec + fres * rimC * (0.34 + 0.3 * u_attn);
      orb += vec3(1.0, 0.72, 0.5) * (u_voice * 0.45 + u_think * 0.14 + u_pulse * 0.1) * z * z;
      orb += vec3(1.0, 0.62, 0.45) * pow(z, 3.0) * 0.12;
      orb *= 0.8 + 0.2 * z;
      col = mix(col, orb, smoothstep(R + 0.8, R - 1.2, d));
    }
  }
  col += vec3(0.42, 0.62, 0.48) * ring(p, 1.0) * 0.38;
  col += (fract(sin(dot(gl_FragCoord.xy + t, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * 2.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export function createOrb(canvas, opts) {
  return createGL(canvas, FRAG, { dprCap: 1.5, minScale: 0.45, ...opts });
}
