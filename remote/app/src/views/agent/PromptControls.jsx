import { motion } from 'motion/react';
import { parsePrompt, rawScreenFor, sendKey } from '../../lib/store.js';
import { press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';

// Interactive-menu controls. When parsePrompt() finds a numbered menu on an
// agent's RAW screen, the question and its options become big tappable rows
// that send single keystrokes — the whole point of the panel on a phone.
// Amber throughout: a menu means the agent is waiting on you.
//
//   `prompt`  — an already-parsed prompt (the caller ran parsePrompt), else it
//               is parsed here off the raw screen.
//   `compact` — the attention-card size: no question, no descriptions, no hint.
export default function PromptControls({ agent, prompt: given = null, compact = false }) {
  const prompt = given ?? (agent ? parsePrompt(rawScreenFor(agent)) : null);
  if (!prompt) return null;

  const pick = (n) => sendKey(agent.id, String(n));
  const nav = (k) => sendKey(agent.id, k);

  // A description can pick up the tail of the TUI's box (╰───╯ isn't a plain
  // ──── rule, so the parser keeps it) — never show box-drawing as prose.
  const descOf = (o) => (o.desc || '').replace(/[│|╭╮╰╯┌┐└┘─━┃]/g, '').trim();

  return (
    <section className={compact ? '' : 'rounded-xl3 border border-warn/30 bg-warn/[0.07] p-4 backdrop-blur-xl'}>
      {!compact && (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            <span className="text-[12px] font-semibold tracking-tight text-warn">Waiting on you</span>
          </div>
          {prompt.question && (
            <p className="mb-3 break-words text-[15px] font-semibold leading-snug tracking-tight text-ink [overflow-wrap:anywhere]">
              {prompt.question}
            </p>
          )}
        </>
      )}

      <div className="flex flex-col gap-2">
        {prompt.options.map((o) => {
          const chosen = prompt.multi ? o.checked : o.selected;
          const cursor = o.selected && !chosen;
          return (
            <motion.button
              key={o.n}
              {...press}
              onClick={() => pick(o.n)}
              className={`flex min-h-[42px] items-start gap-3 rounded-xl2 border px-3.5 py-2.5 text-left transition-colors ${
                chosen
                  ? 'border-accent/55 bg-accent/[0.10]'
                  : cursor
                    ? 'border-glass-line2 bg-white/[0.08]'
                    : 'border-glass-line bg-white/[0.04] hover:border-glass-line2 hover:bg-white/[0.07]'
              }`}
            >
              {prompt.multi ? (
                <span
                  className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md border text-[13px] font-bold ${
                    o.checked ? 'border-accent bg-accent text-accent-ink' : 'border-glass-line2 text-transparent'
                  }`}
                >
                  ✓
                </span>
              ) : (
                <span
                  className={`tnum mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md font-mono text-[13px] font-semibold ${
                    chosen ? 'bg-accent text-accent-ink' : 'bg-white/[0.08] text-ink2'
                  }`}
                >
                  {o.n}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={`break-words text-[14px] font-medium [overflow-wrap:anywhere] ${
                    chosen ? 'text-accent' : 'text-ink'
                  }`}
                >
                  {o.label}
                </span>
                {!compact && descOf(o) && (
                  <span className="mt-0.5 block break-words text-[12.5px] leading-snug text-ink3 [overflow-wrap:anywhere]">
                    {descOf(o)}
                  </span>
                )}
              </span>
              {cursor && <span className="mt-1 flex-none text-[11px] font-medium text-ink3">cursor</span>}
              {chosen && <Icon name="check" size={16} className="mt-1 flex-none text-accent" />}
            </motion.button>
          );
        })}
      </div>

      {!compact && (
        <p className="mt-2.5 flex-none text-[12px] leading-snug text-ink3">
          {prompt.multi ? (
            <>
              Tap options to tick them, then <b className="text-ink2">Submit</b>.
            </>
          ) : (
            <>
              Tap an option to choose it. If it doesn’t confirm on its own, press <b className="text-ink2">Select</b>.
            </>
          )}
        </p>
      )}

      {/* manual navigation, for multi-select and prompts that need an explicit confirm */}
      <div className="mt-2.5 flex flex-none items-center gap-2">
        <motion.button
          {...press}
          onClick={() => nav('up')}
          aria-label="Up"
          className="glass-soft glass-soft-hover grid h-10 w-10 flex-none place-items-center rounded-xl2 text-[15px] text-ink2"
        >
          ↑
        </motion.button>
        <motion.button
          {...press}
          onClick={() => nav('down')}
          aria-label="Down"
          className="glass-soft glass-soft-hover grid h-10 w-10 flex-none place-items-center rounded-xl2 text-[15px] text-ink2"
        >
          ↓
        </motion.button>
        {prompt.multi && (
          <motion.button
            {...press}
            onClick={() => nav('space')}
            className="glass-soft glass-soft-hover h-10 flex-none rounded-xl2 px-4 text-[13px] font-medium text-ink2"
          >
            Toggle
          </motion.button>
        )}
        <motion.button
          {...press}
          onClick={() => nav('enter')}
          className="h-10 flex-1 rounded-xl2 bg-warn px-3 text-[13px] font-semibold text-[#241a02]"
        >
          {prompt.multi ? 'Submit ⏎' : 'Select ⏎'}
        </motion.button>
        <motion.button
          {...press}
          onClick={() => nav('esc')}
          className="glass-soft glass-soft-hover h-10 flex-none rounded-xl2 px-4 text-[13px] font-medium text-ink3"
        >
          Esc
        </motion.button>
      </div>
    </section>
  );
}
