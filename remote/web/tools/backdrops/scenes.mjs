// v6.4 backdrops (task 0620): our own procedural renders, so no licence
// question at all. Each scene is a GLSL fragment shader rendered once, offline,
// at 2048×2048 (cover-cropped to phone portrait and iPad landscape), then
// encoded to webp ~300 KB. Bright, saturated and full of structure — skyline
// windows, aurora rays, dune ridges, silk folds — so the glass has something
// to bend. Palette rule: warm, violet, green; no cyan/blue accents.
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
`;

export const SCENES = [
  {
    file: 'city-night.webp', tone: 'night', title: 'City lights',
    desc: 'A skyline after dark: thousands of lit windows, a warm city glow on the haze, light trails on the waterfront and their reflections.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R; // y up
  float y = uv.y, x = uv.x;
  // sky: plum night → ember city glow at the horizon
  vec3 sky = mix(vec3(.95, .45, .22), vec3(.42, .12, .30), smoothstep(.36, .62, y));
  sky = mix(sky, vec3(.07, .03, .09), smoothstep(.55, 1., y));
  sky += vec3(.25, .08, .12) * fbm(vec2(x * 3., y * 8.) + 4.) * smoothstep(.9, .45, y);
  vec3 c = sky;
  // stars
  vec2 sg = floor(gl_FragCoord.xy / 3.); float st = h(sg); c += step(.9985, st) * smoothstep(.6, .9, y) * vec3(1., .92, .85) * .8;
  float horizon = .34;
  // three rows of buildings, far to near
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float bw = mix(.032, .07, fl / 2.) * (.8 + .5 * h1(floor(x * 9.) + fl));
    float cell = floor((x + fl * .37) / bw);
    float lx = fract((x + fl * .37) / bw);
    float bh = horizon + (.03 + .17 * pow(h1(cell * 7.3 + fl * 31.), 1.6)) * (1. - fl * .25) + (fl == 0. ? .05 : 0.);
    if (L == 0 && h1(cell * 3.1) > .9) bh += .09; // a few towers
    float gap = step(.02, lx) * step(lx, .98);
    if (y < bh && y > horizon - .01 && gap > .5) {
      vec3 wall = mix(vec3(.10, .05, .09), vec3(.03, .02, .04), fl / 2.);
      wall += vec3(.35, .12, .08) * smoothstep(bh - .15, horizon, y) * (.3 - fl * .1); // glow from below
      // windows
      vec2 wg = vec2(lx * mix(14., 10., fl / 2.), (y - horizon) * mix(300., 190., fl / 2.));
      vec2 wi = floor(wg), wf = fract(wg);
      float on = step(.48 - .1 * fl, h(wi + cell * 13. + fl * 91.));
      float win = step(.2, wf.x) * step(wf.x, .8) * step(.25, wf.y) * step(wf.y, .75);
      float hue = h(wi * 1.7 + cell);
      vec3 wc = hue > .92 ? vec3(1., .35, .7) : hue > .75 ? vec3(1., .95, .85) : vec3(1., .72, .38);
      c = wall + wc * win * on * (.65 + .5 * h(wi + 3.)) * (1. - fl * .15);
      // roof beacons
      c += vec3(1., .2, .2) * smoothstep(.006, 0., length(vec2((lx - .5) * bw * R.x / R.y, y - bh + .004))) * step(.8, h1(cell + fl));
    }
  }
  // waterfront road with light trails
  float road = horizon - .012;
  if (y < horizon - .002 && y > road - .02) {
    float tr = y - road;
    c = mix(c, vec3(.05, .03, .05), .8);
    c += vec3(1., .25, .15) * exp(-pow((tr - .004) / .0018, 2.)) * (.8 + .4 * n(vec2(x * 60., 1.)));
    c += vec3(1., .9, .75) * exp(-pow((tr + .008) / .0016, 2.)) * (.7 + .5 * n(vec2(x * 50., 7.)));
  }
  // water: reflection of everything above, stretched and rippled
  if (y < road - .02) {
    float d = (road - .02) - y;
    float rx = x + (n(vec2(x * 8., y * 90.)) - .5) * .012 * (1. + d * 6.);
    float ry = road + d * .9 + (n(vec2(x * 30., y * 400.)) - .5) * .02;
    // re-sample the lit band: windows smear into vertical streaks
    float cell = floor(rx / .03);
    float streak = pow(n(vec2(rx * 140., ry * 6.)), 3.) * step(.35, h1(cell));
    vec3 refl = mix(vec3(1., .55, .25), vec3(1., .85, .7), h1(cell * 2.)) * streak * 1.1 * exp(-d * 5.);
    refl += vec3(.7, .25, .2) * exp(-d * 9.) * .35;
    c = vec3(.04, .025, .05) + refl;
    c += vec3(1., .3, .2) * exp(-pow((ry - road - .004) / .01, 2.)) * pow(n(vec2(rx * 80., y * 300.)), 4.) * .6;
  }
  // haze
  c += vec3(.5, .2, .15) * .25 * exp(-pow((y - horizon - .03) / .05, 2.));
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'aurora.webp', tone: 'night', title: 'Aurora',
    desc: 'Green and magenta aurora curtains with fine rays over dark peaks, a star field, and the lights mirrored in a still lake.',
    frag: `
vec3 skyAt(vec2 uv){
  float y = uv.y, x = uv.x;
  vec3 c = mix(vec3(.10, .05, .12), vec3(.015, .01, .03), smoothstep(.3, 1., y));
  // stars
  vec2 g = floor(uv * R / 2.5);
  float s = h(g);
  c += step(.997, s) * vec3(1., .95, .9) * (.5 + .5 * h(g + 1.));
  // curtains
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float base = .44 + .1 * fi + .09 * sin(x * (2.2 + fi) + fi * 2.) + .06 * (fbm(vec2(x * 2.5 + fi * 5., fi)) - .5);
    float d = y - base;
    float rays = pow(n(vec2(x * 90. + fbm(vec2(x * 4., fi)) * 20., fi * 3.)), 2.) * .8 + .35 * n(vec2(x * 260., fi));
    float body = d > 0. ? exp(-d * (5. + 2. * fi)) : exp(d * 60.);
    vec3 col = mix(vec3(.25, 1., .45), vec3(.95, .25, .75), smoothstep(0., .22, d));
    c += col * body * rays * (.85 - .2 * fi);
  }
  c += vec3(.3, .8, .4) * .08 * exp(-pow((y - .5) / .12, 2.));
  return c;
}
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  float lake = .2;
  vec3 c;
  float ridgeY = .30 + .16 * ridge(vec2(uv.x * 2.2, 1.)) - .05;
  float near = .26 + .08 * fbm(vec2(uv.x * 5., 3.));
  if (uv.y > lake) {
    c = skyAt(uv);
    if (uv.y < ridgeY) { // far peaks with a snow rim lit green
      float rim = smoothstep(.012, 0., ridgeY - uv.y);
      c = mix(vec3(.06, .05, .08), vec3(.16, .22, .15), fbm(uv * vec2(20., 40.))) + vec3(.3, .9, .45) * rim * .6 + vec3(.1, .25, .12) * smoothstep(ridgeY - .12, ridgeY, uv.y);
    }
    if (uv.y < near) c = vec3(.03, .025, .035) + vec3(.05, .09, .06) * fbm(uv * 60.);
  } else {
    float d = lake - uv.y;
    vec2 ruv = vec2(uv.x + (n(vec2(uv.x * 20., uv.y * 300.)) - .5) * .006, lake + d);
    c = skyAt(ruv) * .8;
    if (ruv.y < ridgeY) c = vec3(.05, .07, .05) * (.7 + .6 * n(uv * vec2(30., 200.)));
    if (ruv.y < near) c = vec3(.03, .03, .035) + vec3(.04, .07, .05) * fbm(uv * 50.);
    c *= .8 + .2 * n(vec2(uv.x * 4., uv.y * 500.));
  }
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'dunes-dusk.webp', tone: 'dusk', title: 'Dunes at sunset',
    desc: 'Sharp-crested sand dunes in low sunset light: orange lit faces, violet shadows, a glowing sun on a rose sky.',
    frag: `
float dune(vec2 p, float k){ return .5 + .5 * sin(p.x * 3. + fbm(p * .8 + k) * 4.); }
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec3 c = mix(vec3(1., .62, .35), vec3(.85, .32, .45), smoothstep(.5, .75, uv.y));
  c = mix(c, vec3(.32, .14, .38), smoothstep(.72, 1., uv.y));
  vec2 sp = vec2(.68, .56);
  float sd = length((uv - sp) * vec2(R.x / R.y, 1.));
  c += vec3(1., .85, .6) * smoothstep(.035, .03, sd) + vec3(1., .55, .3) * exp(-sd * 7.) * .6;
  c += vec3(.5, .2, .2) * fbm(vec2(uv.x * 2., uv.y * 12.)) * .2 * smoothstep(.95, .55, uv.y);
  // dune layers, far → near
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float top = .52 - fi * .085 + .06 * (fbm(vec2(uv.x * (1.4 + fi * .6) + fi * 7., fi)) - .5) + .04 * sin(uv.x * (5. + fi) + fi);
    if (uv.y < top) {
      // a sharp crest: lit side vs shadow side by slope of the crest line
      // lit face vs lee face: the smooth part of the crest's slope, plus a diagonal sweep below the crest
      float slope = .04 * (5. + fi) * cos(uv.x * (5. + fi) + fi);
      float side = smoothstep(-.12, .12, slope + (top - uv.y) * 1.5 * sin(uv.x * 3. + fi * 2.) + (fbm(uv * 2.5 + fi) - .5) * .25);
      vec3 lit = mix(vec3(1., .58, .28), vec3(.95, .42, .25), fi / 4.);
      vec3 shade = mix(vec3(.45, .2, .38), vec3(.18, .08, .2), fi / 4.);
      float depth = clamp((top - uv.y) * 6., 0., 1.);
      vec3 col = mix(lit, shade, side);
      col = mix(col, col * .7, depth);
      // wind ripples
      col *= .93 + .07 * sin(uv.y * 700. * (1. + fi * .3) + fbm(uv * 5. + fi) * 30.);
      col += vec3(1., .8, .5) * smoothstep(.006, 0., top - uv.y) * .5; // crest highlight
      c = mix(col, vec3(.95, .5, .4), .35 * (1. - fi / 4.) * (1. - depth)); // haze on far dunes
    }
  }
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'peaks-dawn.webp', tone: 'dawn', title: 'Peaks at dawn',
    desc: 'Layer after layer of mountain ridges in morning haze, a rose-gold sky and the first sun catching the snow.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec3 c = mix(vec3(1., .78, .55), vec3(.95, .55, .6), smoothstep(.45, .7, uv.y));
  c = mix(c, vec3(.42, .3, .55), smoothstep(.68, 1., uv.y));
  vec2 sp = vec2(.3, .5);
  float sd = length((uv - sp) * vec2(R.x / R.y, 1.));
  c += vec3(1., .9, .7) * exp(-sd * 5.) * .7;
  // clouds
  float cl = fbm(vec2(uv.x * 3., uv.y * 10.) + 2.);
  c = mix(c, vec3(1., .75, .7), smoothstep(.55, .8, cl) * .5 * smoothstep(.6, .85, uv.y));
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float top = .58 - fi * .075 + .14 * (ridge(vec2(uv.x * (1.2 + fi * .5) + fi * 3.3, fi)) - .55) * (1. - fi * .1);
    if (uv.y < top) {
      float far = 1. - fi / 5.;
      vec3 base = mix(vec3(.22, .12, .24), vec3(.75, .45, .55), far * .8);
      // sun-facing slopes catch warm light, snow near the tops of the far ranges
      float lightS = fbm(vec2(uv.x * 14. + fi, uv.y * 4.));
      vec3 col = base * (.7 + .6 * lightS);
      float snow = smoothstep(.06, 0., top - uv.y) * step(fi, 2.) * smoothstep(.4, .7, fbm(uv * 40.));
      col = mix(col, vec3(1., .85, .78), snow * .8);
      // mist pooling in the valley below each ridge
      col = mix(col, vec3(1., .78, .7), smoothstep(.12, 0., uv.y - (top - .14)) * .35 * far);
      c = col;
      // detail: forest texture on the nearest ranges
      if (fi > 3.) c *= .75 + .35 * n(uv * vec2(400., 120.));
    }
  }
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'hills-day.webp', tone: 'day', title: 'Hills in the sun',
    desc: 'Rolling green and gold hills under a warm hazy sky: field stripes, hedgerows and lone trees.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec3 c = mix(vec3(1., .93, .78), vec3(.88, .78, .7), smoothstep(.55, 1., uv.y));
  float cl = fbm(vec2(uv.x * 2.5, uv.y * 6.) + 9.);
  c = mix(c, vec3(1.), smoothstep(.5, .75, cl) * .6 * smoothstep(.55, .8, uv.y));
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float top = .56 - fi * .085 + .05 * sin(uv.x * (2.5 + fi * .7) + fi * 1.9) + .03 * (fbm(vec2(uv.x * 3. + fi, fi)) - .5);
    if (uv.y < top) {
      float far = 1. - fi / 5.;
      // fields: stripes along the slope, patchwork colours
      vec2 fp = vec2(uv.x * (6. + fi * 3.) + fbm(uv * 3. + fi) * 2., (top - uv.y) * (30. + fi * 10.));
      float patch = h(floor(fp * vec2(1., .4)) + fi * 10.);
      vec3 g1 = vec3(.45, .7, .25), g2 = vec3(.85, .75, .3), g3 = vec3(.3, .55, .2);
      vec3 col = patch > .66 ? g2 : patch > .33 ? g1 : g3;
      col *= .85 + .2 * sin(fp.x * 40.);
      // hedgerows between patches
      vec2 ff = fract(fp * vec2(1., .4));
      col = mix(col, vec3(.12, .25, .08), smoothstep(.04, 0., min(ff.x, 1. - ff.x)) * .9);
      // shade the far side, sun from top-left
      col *= .75 + .35 * smoothstep(0., .08, top - uv.y) * (1. - .3 * uv.x);
      // trees
      vec2 tg = uv * vec2(90., 60.) * (1. + fi * .4);
      vec2 ti = floor(tg), tf = fract(tg) - .5;
      if (h(ti + fi) > .94) col = mix(col, vec3(.08, .2, .06), smoothstep(.35, .2, length(tf)));
      c = mix(col, vec3(.95, .9, .8), far * .45);
    }
  }
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'silk-day.webp', tone: 'day', title: 'Silk',
    desc: 'An abstract colour field: folds of silk in coral, gold, magenta and violet with crisp highlights along every fold.',
    frag: `
float H(vec2 p){ return .55 * sin(p.x * 2.1 + 1.5 * fbm(p * .7)) + .35 * sin(p.y * 1.6 + p.x * .8 + 2. * fbm(p * .5 + 3.)) + .2 * fbm(p * 2.); }
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec2 p = uv * 4.;
  float e = .01;
  float hh = H(p);
  vec3 nn = normalize(vec3(H(p - vec2(e, 0.)) - H(p + vec2(e, 0.)), H(p - vec2(0., e)) - H(p + vec2(0., e)), 2. * e * 3.));
  vec3 L = normalize(vec3(-.5, .6, .7));
  float dif = clamp(dot(nn, L), 0., 1.);
  float spec = pow(clamp(dot(reflect(-L, nn), vec3(0., 0., 1.)), 0., 1.), 40.);
  float t = fbm(p * .35 + hh);
  vec3 a = vec3(1., .45, .35), b = vec3(1., .78, .3), m = vec3(.85, .2, .55), v = vec3(.45, .2, .7);
  vec3 col = mix(a, b, smoothstep(.3, .6, t));
  col = mix(col, m, smoothstep(.5, .75, uv.x * .6 + t * .6));
  col = mix(col, v, smoothstep(.55, .95, uv.y * .7 + (1. - t) * .4));
  vec3 c = col * (.35 + .8 * dif) + vec3(1., .95, .9) * spec * .7;
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'prism-dusk.webp', tone: 'dusk', title: 'Prism field',
    desc: 'An abstract field of warm light split into bands: soft colour clouds crossed by fine refracted lines.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec2 q = uv * 2.;
  vec2 w = vec2(fbm(q + 1.), fbm(q + 7.));
  float f = fbm(q + 2.5 * w);
  vec3 c = mix(vec3(.25, .06, .2), vec3(.95, .3, .35), smoothstep(.3, .7, f));
  c = mix(c, vec3(1., .65, .25), smoothstep(.55, .85, w.x * f * 1.7));
  c = mix(c, vec3(.55, .25, .85), smoothstep(.6, .9, w.y) * .7);
  // fine bands, like light through a prism
  float band = sin((uv.x * .6 + uv.y + f * .8) * 160.);
  c *= .88 + .14 * band;
  float lines = pow(abs(sin((f * 6. + w.x * 4.) * 3.14159)), 60.);
  c += vec3(1., .85, .7) * lines * .5;
  c += vec3(1., .9, .8) * exp(-length((uv - vec2(.7, .7)) * vec2(1., 1.4)) * 4.) * .35;
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
  {
    file: 'ember-dawn.webp', tone: 'dawn', title: 'Ember field',
    desc: 'An abstract dawn colour field: peach and rose light flowing over deep plum, with fine contour lines.',
    frag: `
void main(){
  vec2 uv = gl_FragCoord.xy / R;
  vec2 q = uv * vec2(1.6, 2.4);
  vec2 w = vec2(fbm(q * 1.3), fbm(q * 1.3 + 4.1));
  vec2 w2 = vec2(fbm(q + 2. * w + vec2(1.7, 9.2)), fbm(q + 2. * w + vec2(8.3, 2.8)));
  float f = fbm(q + 2.4 * w2);
  vec3 c = mix(vec3(.12, .04, .14), vec3(.85, .3, .42), smoothstep(.3, .7, f));
  c = mix(c, vec3(1., .66, .45), smoothstep(.5, .85, w2.x));
  c = mix(c, vec3(1., .88, .72), smoothstep(.62, .95, w2.y * f * 1.6) * .8);
  // contour lines of the flow
  float iso = abs(fract(f * 14.) - .5);
  c += vec3(1., .85, .75) * smoothstep(.04, .0, iso) * .18;
  c *= mix(1., .55, smoothstep(.4, 1.2, length(uv - vec2(.45, .6)) * 1.3));
  gl_FragColor = vec4(grain(c, gl_FragCoord.xy), 1.);
}`,
  },
];
