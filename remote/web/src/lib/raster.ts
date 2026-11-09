// v6.3 — the content the glass refracts. Daniel: "it has nothing to refract".
// The lens layer used to bend only the backdrop. Now the visible pane content
// (cards, text, chips, orbs, images) is painted into a canvas at a low rate and
// uploaded as a texture; the lens shader samples it with the same rim
// displacement, so cards and text scrolling under the dock and the top pills
// visibly bend and magnify in the edge band, with a chromatic fringe.
//
// Cheap on an iPhone: the snapshot covers a window 3 screens tall (one above,
// one below), so scrolling only shifts a uniform each frame; a new snapshot is
// taken when the scroll leaves the window, when scrolling settles, when the
// tab changes and (throttled) when the DOM changes. Works in WebKit — plain
// 2D canvas drawing, no foreignObject, no html2canvas.

export interface Snapshot {
  canvas: HTMLCanvasElement;
  pane: HTMLElement | null;
  scroll: number; // pane.scrollTop when painted
  k: number; // px per CSS px
  v: number; // bumps on every repaint
  H: number; // viewport height when painted
}

const firstColor = (s: string) => s.match(/rgba?\([^)]*\)/)?.[0] || '';
const alphaOf = (c: string) => {
  const m = c.match(/rgba?\(([^)]*)\)/);
  if (!m) return 0;
  const p = m[1].split(/[ ,/]+/).filter(Boolean);
  return p.length > 3 ? parseFloat(p[3]) : 1;
};

function rrect(x: CanvasRenderingContext2D, l: number, t: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  x.beginPath();
  if ((x as any).roundRect) (x as any).roundRect(l, t, w, h, r);
  else {
    x.moveTo(l + r, t);
    x.arcTo(l + w, t, l + w, t + h, r);
    x.arcTo(l + w, t + h, l, t + h, r);
    x.arcTo(l, t + h, l, t, r);
    x.arcTo(l, t, l + w, t, r);
    x.closePath();
  }
}

export function activePane(): HTMLElement | null {
  return document.querySelector('.pane[aria-hidden="false"]') as HTMLElement | null;
}

// Paint what's in [-H, 2H] (viewport coords) of the active pane.
export function paint(snap: Snapshot | null, maxTex: number): Snapshot {
  const W = innerWidth, H = innerHeight;
  const k = Math.max(0.5, Math.min(2, devicePixelRatio || 1, maxTex / (3 * H), maxTex / W));
  const canvas = snap?.canvas || document.createElement('canvas');
  const cw = Math.round(W * k), ch = Math.round(3 * H * k);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const x = canvas.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, cw, ch);
  x.setTransform(k, 0, 0, k, 0, H * k);
  const pane = activePane();
  const out: Snapshot = { canvas, pane, scroll: pane ? pane.scrollTop : 0, k, v: (snap?.v || 0) + 1, H };
  if (!pane) return out;
  x.textBaseline = 'alphabetic';
  let budget = 2600; // text runs
  const inWin = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > -H && r.top < 2 * H;
  const range = document.createRange();

  const walk = (el: Element, alpha: number) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const a = alpha * parseFloat(cs.opacity || '1');
    if (a < 0.05) return;
    if (el !== pane && el.classList.contains('lens')) return; // a control never refracts itself
    const r = el.getBoundingClientRect();
    const visible = inWin(r);
    if (!visible && cs.overflow !== 'visible' && el !== pane) return;
    if (visible && el !== pane) {
      const rad = parseFloat(cs.borderTopLeftRadius) || 0;
      x.globalAlpha = a;
      const tag = el.tagName;
      if (el.classList.contains('glass')) {
        // the frosted card: a light body and a hairline rim lit from the top
        rrect(x, r.left, r.top, r.width, r.height, rad);
        x.fillStyle = 'rgba(255,255,255,0.13)';
        x.fill();
        const g = x.createLinearGradient(0, r.top, 0, r.bottom);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.4, 'rgba(255,255,255,0.12)');
        g.addColorStop(1, 'rgba(255,255,255,0.22)');
        x.strokeStyle = g;
        x.lineWidth = 1;
        x.stroke();
      } else {
        let bg = alphaOf(cs.backgroundColor) > 0.02 ? cs.backgroundColor : '';
        if (!bg && cs.backgroundImage.includes('gradient')) bg = firstColor(cs.backgroundImage);
        if (bg) {
          rrect(x, r.left, r.top, r.width, r.height, rad);
          if (cs.backgroundImage.includes('radial') && r.width > 24) {
            const cols = cs.backgroundImage.match(/rgba?\([^)]*\)/g) || [bg];
            const g = x.createRadialGradient(r.left + r.width * 0.4, r.top + r.height * 0.35, 0, r.left + r.width / 2, r.top + r.height / 2, Math.max(r.width, r.height) * 0.6);
            cols.slice(0, 4).forEach((c, i, l) => g.addColorStop(l.length > 1 ? i / (l.length - 1) : 0, c));
            x.fillStyle = g;
          } else x.fillStyle = bg;
          x.fill();
        }
        const bw = parseFloat(cs.borderTopWidth) || 0;
        if (bw > 0 && alphaOf(cs.borderTopColor) > 0.05) {
          rrect(x, r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, rad);
          x.strokeStyle = cs.borderTopColor;
          x.lineWidth = bw;
          x.stroke();
        }
        if (tag === 'IMG') {
          try { x.drawImage(el as HTMLImageElement, r.left, r.top, r.width, r.height); } catch { /* not ready */ }
        } else if (tag === 'svg') {
          // icons/charts: a soft mark in the text colour keeps their shape readable when bent
          x.strokeStyle = cs.color;
          x.lineWidth = 1.4;
          el.querySelectorAll('circle,rect,path,line,polyline').forEach((s) => {
            const q = (s as SVGGraphicsElement).getBoundingClientRect();
            if (q.width + q.height < 1) return;
            x.globalAlpha = a * 0.7;
            rrect(x, q.left, q.top, Math.max(1, q.width), Math.max(1, q.height), Math.min(q.width, q.height) / 2);
            x.stroke();
          });
          return;
        }
      }
    }
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) walk(n as Element, a);
      else if (n.nodeType === 3 && budget > 0) {
        const t = n.textContent || '';
        if (!t.trim()) continue;
        range.selectNodeContents(n);
        const rs = range.getClientRects();
        if (!rs.length) continue;
        if (rs[0].bottom < -H || rs[rs.length - 1].top > 2 * H) continue;
        x.globalAlpha = a;
        x.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        x.fillStyle = cs.color;
        const fs = parseFloat(cs.fontSize) || 14;
        const base = (q: DOMRect) => q.top + q.height / 2 + fs * 0.36;
        if (rs.length === 1) {
          budget--;
          x.fillText(t.replace(/\s+/g, ' ').trim(), rs[0].left, base(rs[0]), rs[0].width + 2);
        } else {
          // wrapped: one run per word
          const re = /\S+/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(t)) && budget > 0) {
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            const q = range.getBoundingClientRect();
            if (q.bottom < -H || q.top > 2 * H || !q.width) continue;
            budget--;
            x.fillText(m[0], q.left, base(q));
          }
        }
      }
    }
  };
  walk(pane, 1);
  x.globalAlpha = 1;
  return out;
}
