import { useMC, fmtTokens } from '../../lib/store.js';
import Ticker from '../../ui/Ticker.jsx';
import { Section, Head, Key } from './parts.jsx';

// Token economics for the session. The headline is the cache-hit rate — the
// single biggest cost lever when developing with Claude: input tokens served
// from cache are ~10× cheaper than fresh ones. The bar underneath shows where
// every token went.
//
// Segment ORDER is deliberate, not semantic drift: cache read (#c08a2a) and
// cache write (#d97788) sit only ΔE 13.8 apart for normal vision, so they must
// never touch. Putting fresh input between them puts every adjacent pair above
// the separation floor (validated: dataviz `validate_palette.js`, dark mode).
const PARTS = [
  { key: 'output', label: 'Output', color: 'var(--color-s1)', pick: (s) => s.outputTokens ?? 0 },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--color-s3)', pick: (s) => s.cacheReadTokens ?? 0 },
  { key: 'input', label: 'Fresh input', color: 'var(--color-s2)', pick: (s) => s.inputTokens ?? 0 },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--color-s4)', pick: (s) => s.cacheCreateTokens ?? 0 },
];

export default function TokenMix() {
  const s = useMC((st) => st.summary) || {};
  const parts = PARTS.map((p) => ({ ...p, v: p.pick(s) }));
  const total = parts.reduce((a, p) => a + p.v, 0);

  // Of every input-side token, what fraction came from cache rather than being
  // paid for fresh. Higher = cheaper, faster context.
  const read = s.cacheReadTokens ?? 0;
  const denom = read + (s.inputTokens ?? 0) + (s.cacheCreateTokens ?? 0);
  const hit = denom ? Math.round((100 * read) / denom) : null;
  const hitTone = hit === null ? 'text-ink3' : hit >= 80 ? 'text-ok' : hit >= 50 ? 'text-warn' : 'text-crit';

  return (
    <Section className="flex flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Head title="Cache hit rate" />
          <div className={`mt-1.5 text-[26px] leading-none font-semibold tracking-tight ${hitTone}`}>
            {hit === null ? '—' : <><Ticker value={hit} />%</>}
          </div>
        </div>
        <div className="flex-none text-right">
          <Head title="Tokens" className="justify-end" />
          <div className="mt-1.5 text-[15px] font-medium text-ink">
            <Ticker value={total} format={fmtTokens} />
          </div>
        </div>
      </div>

      {/* The card is stretched to its grid row (machine health sets the height),
          so bar + legend ride the middle rather than leaving a void under them. */}
      <div className="mt-4 flex flex-1 flex-col justify-center">
        {/* Composition bar. 2px gaps in the surface colour do the separating —
            no strokes, which would add ink that isn't data. */}
        <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-black/35">
          {total
            ? parts
                .filter((p) => p.v > 0)
                .map((p) => (
                  <div
                    key={p.key}
                    className="h-full transition-[width] duration-700"
                    style={{ width: `${(100 * p.v) / total}%`, background: p.color }}
                    title={`${p.label} · ${fmtTokens(p.v)}`}
                  />
                ))
            : null}
        </div>

        {/* Legend: identity is never colour alone — every slice has a label and
            its value right here, so the bar never has to be decoded. */}
        <div className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-2">
          {parts.map((p) => (
            <div key={p.key} className="flex items-center gap-2 text-[12px]">
              <Key color={p.color} />
              <span className="min-w-0 flex-1 truncate text-ink2">{p.label}</span>
              <span className="tnum flex-none text-ink3">{fmtTokens(p.v)}</span>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
