'use client';
// The living backdrop: a small WebGL shader of warm liquid light — domain-
// warped colour fields that slowly flow, a soft light source that drifts
// across the scene, and out-of-focus motes rising through it. Rendered at a
// fraction of screen resolution (it sits behind blurred glass, so detail is
// wasted) and at 30 fps, paused while the page is hidden. Palette: ember,
// rose, violet, plum — no blue/cyan. Activity (agents working) makes it
// flow a little faster and brighter.

import { useEffect, useRef } from 'react';
import { energy as sharedEnergy, sceneTime, useGlassPrefs } from '@/lib/glass';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
// The liquid light as a GLSL function, shared with the glass lens layer so a
// lens refracts exactly the light the backdrop shows. uv: 0..1, y up.
export const LIQUID_GLSL = `
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*n(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
vec3 liquid(vec2 uv, vec2 r, float t, float energy, float photo){
  vec2 q = uv; q.x *= r.x / r.y;
  float s = t * (0.018 + 0.02 * energy);
  vec2 w1 = vec2(fbm(q*1.6 + s), fbm(q*1.6 - s + 4.1));
  vec2 w2 = vec2(fbm(q*1.2 + 2.*w1 + vec2(1.7, 9.2) + s*1.3), fbm(q*1.2 + 2.*w1 + vec2(8.3, 2.8) - s));
  float f = fbm(q*1.1 + 2.4*w2);
  vec3 plum = vec3(.10,.05,.12), violet = vec3(.42,.22,.62), rose = vec3(.78,.32,.42), ember = vec3(.95,.55,.30), sand = vec3(.98,.85,.68);
  vec3 c = mix(plum, violet, smoothstep(.2,.7,f));
  c = mix(c, rose, smoothstep(.45,.85, w2.x) * .75);
  c = mix(c, ember, smoothstep(.55,.95, w2.y*f*1.6) * .7);
  vec2 L = vec2(.5 + .38*sin(t*.031), .62 + .22*cos(t*.023)); L.x *= r.x/r.y;
  float d = length(q - L);
  c += sand * .35 * exp(-d*d*3.2) * (.7 + .3*energy);
  // v6.5 (task 0623): over a photo backdrop the light stays a soft, slow wash
  // (no veins, ripples or sparkles: Daniel rejected the streaky look)
  if (photo > .5) {
    c *= mix(1., .35, smoothstep(.35, 1.25, length(uv - vec2(.5,.55)) * 1.4));
    return c * .3;
  }
  float cf = pow(abs(sin((f*9. + w2.x*6.) - t*.12)), 18.);
  c += vec3(1., .8, .7) * cf * .05;
  // v6.4: more structure — thin bright caustic veins riding the flow, and a
  // slow interference ripple, so the glass has edges and lines to bend
  float vein = 1. - abs(2. * fbm(q * 2.6 + 1.8 * w2 - s * 1.5) - 1.);
  c += vec3(1., .78, .62) * pow(vein, 12.) * (.26 + .1 * energy);
  c += vec3(.9, .5, .55) * .04 * sin(f * 40. + t * .2) * smoothstep(.4, .8, f);
  for (int i = 0; i < 3; i++) {
    float sc = 7. + float(i) * 5.;
    vec2 g = q * sc + vec2(0., -t * (.05 + .03*float(i)));
    vec2 id = floor(g); vec2 fp = fract(g) - .5;
    float rnd = h(id + float(i)*13.);
    vec2 o = vec2(h(id+2.3)-.5, h(id+7.1)-.5) * .6;
    float m = smoothstep(.16, .0, length(fp - o)) * step(.86, rnd);
    c += sand * m * (.10 + .08*sin(t*.8 + rnd*30.));
  }
  c *= mix(1., .35, smoothstep(.35, 1.25, length(uv - vec2(.5,.55)) * 1.4));
  c *= mix(1., .55, photo);
  return c;
}`;
const FRAG = `
precision mediump float;
uniform vec2 r; uniform float t; uniform float energy; uniform float photo;
${LIQUID_GLSL}
void main(){ gl_FragColor = vec4(liquid(gl_FragCoord.xy / r, r, t, energy, photo), 1.); }`;

export function Liquid({ photo = true }: { photo?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const calm = useGlassPrefs((s) => s.calm);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) {
      cv.style.display = 'none';
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      cv.style.display = 'none';
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uR = gl.getUniformLocation(prog, 'r');
    const uT = gl.getUniformLocation(prog, 't');
    const uE = gl.getUniformLocation(prog, 'energy');
    const uP = gl.getUniformLocation(prog, 'photo');
    const SCALE = 0.4; // v6.4: a bit finer, so the veins stay crisp enough to refract
    const resize = () => {
      cv.width = Math.max(64, Math.round(innerWidth * SCALE));
      cv.height = Math.max(64, Math.round(innerHeight * SCALE));
      gl.viewport(0, 0, cv.width, cv.height);
    };
    resize();
    addEventListener('resize', resize);
    // calm: one still frame, no animation loop
    const calmT = 400;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      gl.uniform2f(uR, cv.width, cv.height);
      gl.uniform1f(uT, t);
      gl.uniform1f(uE, sharedEnergy.value);
      gl.uniform1f(uP, photo ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    if (calm) {
      draw(calmT);
      const redraw = () => draw(calmT);
      addEventListener('resize', redraw);
      return () => { removeEventListener('resize', resize); removeEventListener('resize', redraw); };
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - last < 33) return;
      last = now;
      sharedEnergy.value += (sharedEnergy.target - sharedEnergy.value) * 0.03;
      gl.uniform2f(uR, cv.width, cv.height);
      gl.uniform1f(uT, sceneTime(now));
      gl.uniform1f(uE, sharedEnergy.value);
      gl.uniform1f(uP, photo ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
    };
  }, [photo, calm]);
  return <canvas ref={ref} className="liquid" aria-hidden />;
}
