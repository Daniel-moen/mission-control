// v6.5 backdrops (task 0623; v6.4's aurora/skyline/silk sets were rejected:
// "the background is ass"). Calm, Apple-wallpaper-like: deep smooth gradients
// with a few large, very soft colour blooms and a gentle silk-like sweep — no
// streaks, no rays, no busy texture. Our own procedural renders (no licence
// question), 2048×2048, cover-cropped. Palette: deep, low-saturation, warm/violet
// with a muted violet-slate night (no blue, per the design language); text on top must stay legible.
// node tools/backdrops/render.mjs regenerates public/bg6/.

export const COMMON = `
precision highp float;
uniform vec2 R;
float h1(float n){ return fract(sin(n) * 43758.5453); }
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3. - 2.*f);
  return mix(mix(h(i), h(i + vec2(1,0)), f.x), mix(h(i + vec2(0,1)), h(i + vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 7; i++){ v += a * n(p); p = p * 2.02 + vec2(1.7, 9.2); a *= .5; } return v; }
float ridge(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 6; i++){ v += a * (1. - abs(2.*n(p) - 1.)); p = p * 2.03 + vec2(3.1, 1.3); a *= .5; } return v; }
vec3 grain(vec3 c, vec2 fc){ return c + (h(fc) - .5) / 255. * 3.; }
// a soft bloom: gaussian falloff around p (aspect-corrected), radius r
float bloom(vec2 uv, vec2 p, float r){ vec2 d = uv - p; return exp(-dot(d, d) / (r * r)); }
// a broad, slow silk fold: a soft band along a gently curving line
float fold(vec2 uv, float a, float b, float c, float w){ float y = a + b * uv.x + c * sin(uv.x * 2.4 + 1.3); return exp(-pow((uv.y - y) / w, 2.)); }
// low-frequency warp so blooms are organic, never geometric
vec2 warp(vec2 uv){ return uv + .06 * vec2(n(uv * 2.1 + 3.), n(uv * 2.1 + 11.)) - .03; }
vec3 finish(vec3 c, vec2 uv, vec2 fc){
  c *= mix(1., .78, smoothstep(.45, 1.05, length(uv - vec2(.5, .55)) * 1.25)); // gentle vignette
  c = c / (1. + .15 * c); // soft shoulder
  return grain(pow(max(c, 0.), vec3(1. / 1.05)), fc);
}

`;


export const SCENES = [
  {
    file: 'midnight.webp', tone: 'night', title: 'Midnight',
    desc: 'Deep ink night with a low violet-slate glow and a faint plum bloom, smooth as a lacquered surface.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R, w = warp(uv);
  vec3 c = mix(vec3(.055, .047, .07), vec3(.022, .02, .03), uv.y);
  c += vec3(.14, .10, .20) * bloom(w, vec2(.22, .18), .42);
  c += vec3(.16, .07, .19) * bloom(w, vec2(.86, .78), .38);
  c += vec3(.07, .06, .11) * fold(w, .38, .22, .05, .07);
  c += vec3(.12, .10, .16) * fold(w, .30, .25, .05, .032) * .2;
  gl_FragColor = vec4(finish(c, uv, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'dawn-haze.webp', tone: 'dawn', title: 'Dawn haze',
    desc: 'Plum night lifting into a soft peach and rose glow along the bottom, with lavender haze in between.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R, w = warp(uv);
  vec3 c = mix(vec3(.30, .16, .20), vec3(.07, .05, .11), smoothstep(.0, .85, uv.y));
  c += vec3(.48, .26, .18) * bloom(w, vec2(.62, -.02), .44);
  c += vec3(.20, .12, .26) * bloom(w, vec2(.15, .62), .40);
  c += vec3(.22, .12, .14) * fold(w, .30, -.12, .04, .08);
  c += vec3(.30, .18, .18) * fold(w, .26, -.12, .04, .016) * .45;
  gl_FragColor = vec4(finish(c, uv, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'stone-day.webp', tone: 'day', title: 'Warm stone',
    desc: 'Muted graphite rising into warm sand and soft clay light, like late-morning sun on a stone wall.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R, w = warp(uv);
  vec3 c = mix(vec3(.25, .24, .26), vec3(.11, .11, .14), smoothstep(.0, 1., uv.y));
  c += vec3(.34, .24, .16) * bloom(w, vec2(.80, .84), .46);
  c += vec3(.14, .13, .20) * bloom(w, vec2(.12, .20), .42);
  c += vec3(.16, .12, .10) * fold(w, .58, -.28, .05, .09);
  c += vec3(.22, .17, .13) * fold(w, .52, -.28, .05, .032) * .2;
  gl_FragColor = vec4(finish(c, uv, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'ember-dusk.webp', tone: 'dusk', title: 'Ember dusk',
    desc: 'Deep aubergine with a single warm amber glow low on the right and a soft rose fold across it.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R, w = warp(uv);
  vec3 c = mix(vec3(.14, .06, .10), vec3(.05, .03, .07), smoothstep(.0, .9, uv.y));
  c += vec3(.50, .22, .10) * bloom(w, vec2(.88, .10), .40);
  c += vec3(.22, .08, .18) * bloom(w, vec2(.10, .86), .44);
  c += vec3(.20, .08, .10) * fold(w, .22, .30, .05, .09);
  c += vec3(.28, .12, .10) * fold(w, .16, .30, .05, .032) * .2;
  gl_FragColor = vec4(finish(c, uv, gl_FragCoord.xy), 1.);
}`,
  },
];
