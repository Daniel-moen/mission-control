// Lens (task 0445): a tiny full-screen fragment-shader runner — no three.js
// (≈150 KB we don't need for one quad). One canvas, one program, one draw per
// frame, and it looks after itself on a phone:
//   • adaptive resolution: renders at up to `dprCap` × CSS pixels and steps
//     the scale down (to `minScale`) when frames run long, back up when idle
//     headroom returns — the GPU cost follows what the device can afford
//   • stops drawing when the tab is hidden; `still` renders single frames
//     (reduced motion / low power) only when asked to via `draw()`
//   • `ok === false` when there is no WebGL at all: callers show their CSS
//     fallback instead

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// `calmDt` / `calmN` / `streak` (task 0503, v5.3): the recovery test. The
// default (13 ms × 180) can only pass on a 120 Hz screen, so on a 60 Hz one
// (an iPhone in Low Power Mode, most iPads) a single busy spell — a page
// mounting — left the glass at its lowest resolution for good. v5.3 counts
// a frame that makes vsync as calm, needs the slow frames to be consecutive,
// ignores one-off stalls (a main-thread hitch is not the GPU), and backs off
// if it keeps bouncing.
export function createGL(canvas, frag, { dprCap = 1.5, minScale = 0.45, still = false, onFrame = null, alpha = false, calmDt = 13, calmN = 180, streak = false } = {}) {
  const gl =
    canvas.getContext('webgl', { antialias: false, alpha, premultipliedAlpha: false, depth: false, stencil: false, powerPreference: 'default', preserveDrawingBuffer: false }) || null;
  if (!gl) return { ok: false, start() {}, stop() {}, set() {}, draw() {}, destroy() {}, texture() {} };

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision highp float;\n${frag}`));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uni = {};
  const U = (name) => (name in uni ? uni[name] : (uni[name] = gl.getUniformLocation(prog, name)));
  const vals = {};
  const f1 = new Set(); // names sent as float arrays (uniform1fv)
  const set = (name, v, kind) => {
    vals[name] = v;
    if (kind === '1fv') f1.add(name);
  };
  const apply = () => {
    for (const k in vals) {
      const v = vals[k];
      const l = U(k);
      if (l == null) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (f1.has(k)) gl.uniform1fv(l, v);
      else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
      else if (v.length % 4 === 0) gl.uniform4fv(l, v);
    }
  };

  // Textures: an image or canvas, mipmapped (power-of-two sources only — the
  // callers draw into a POT canvas) so the shader can blur by LOD bias.
  const textures = {};
  const texture = (name, src, unit = 0) => {
    let t = textures[name];
    if (!t) {
      t = textures[name] = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.uniform1i(U(name), unit);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
  };

  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  let scale = 1;
  let w = 0;
  let h = 0;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width * dpr * scale));
    const nh = Math.max(1, Math.round(r.height * dpr * scale));
    if (nw !== w || nh !== h) {
      w = canvas.width = nw;
      h = canvas.height = nh;
      gl.viewport(0, 0, w, h);
    }
    // Shaders work in CSS pixels; px = device pixels per CSS pixel.
    set('u_res', [r.width, r.height]);
    set('u_px', dpr * scale);
    stats.backing = [w, h];
  };

  let hook = onFrame;
  let raf = 0;
  let t0 = performance.now();
  let last = t0;
  let slow = 0;
  let fast = 0;
  let backoff = 1;
  const stats = { frames: 0, scale: 1, dpr };
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = now - last;
    last = now;
    // Adapt: 8 long frames in a row → render fewer pixels; 3 s of easy
    // frames → try more again. (dt includes the compositor, so it's honest.)
    if (dt > 21 && !(streak && dt > 120)) slow += 1;
    else slow = streak ? 0 : Math.max(0, slow - 1);
    if (dt < calmDt) fast += 1;
    else fast = 0;
    if (slow > 8 && scale > minScale) {
      scale = Math.max(minScale, scale * 0.8);
      slow = 0;
      fast = 0;
      if (streak) backoff = Math.min(8, backoff * 2);
      resize();
    } else if (fast > calmN * backoff && scale < 1) {
      scale = Math.min(1, scale * 1.15);
      fast = 0;
      resize();
    }
    stats.frames += 1;
    stats.scale = scale;
    render(now, dt);
  };
  const render = (now = performance.now(), dt = 16) => {
    set('u_time', (now - t0) / 1000);
    hook?.(now, dt, set);
    apply();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const vis = () => {
    if (document.hidden) stop();
    else if (!still) start();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (resize(), still && render())) : null;
  ro?.observe(canvas);
  document.addEventListener('visibilitychange', vis);
  resize();

  function start() {
    if (raf || still) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  // Perf rigs: the shader's real cost — n frames, each forced to finish on
  // the GPU — and which GPU/driver ran it.
  stats.bench = (n = 60) => {
    const was = raf;
    stop();
    // readPixels waits for the GPU (finish() doesn't, in Chrome's GPU process)
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const ms = (performance.now() - t) / n;
    if (was) start();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { msPerFrame: +ms.toFixed(2), px: `${w}x${h}`, scale, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  };
  // Tests: the rendered colour at CSS-px points, straight from the GPU
  // (the contrast checks read what's actually behind the text).
  stats.sample = (pts) => {
    render();
    const px = new Uint8Array(4);
    return pts.map(([x, y]) => {
      gl.readPixels(Math.round(x * dpr * scale), Math.round(h - y * dpr * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0] / 255, px[1] / 255, px[2] / 255];
    });
  };
  window.__v3gl = stats;
  return {
    ok: true,
    gl,
    stats,
    set,
    texture,
    start,
    stop,
    draw: () => render(),
    setFrame: (fn) => (hook = fn),
    destroy() {
      stop();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', vis);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl');
  } catch {
    return false;
  }
}
