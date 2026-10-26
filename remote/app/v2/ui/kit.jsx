import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import Icon from '../../src/ui/Icon.jsx';
import { spring, tap } from '../lib/motion.js';
import { dictate, speechSupported } from '../../src/lib/speech.js';

export { Icon };

// ---------------------------------------------------------------------------
// Buttons. One shape (a capsule), a few tones. Every press sinks on a spring.

const TONE = {
  primary: 'bg-ink text-page',
  accent: 'bg-accent text-accent-ink',
  secondary: 'bg-fill text-ink hover:bg-fill2',
  ghost: 'text-ink2 hover:bg-fill hover:text-ink',
  danger: 'bg-crit/12 text-crit hover:bg-crit/18',
  dangerSolid: 'bg-crit text-white',
  warn: 'bg-warn text-[#241a02]',
};
const SIZE = {
  sm: 'h-8 px-3 text-[0.8rem] gap-1.5',
  md: 'h-10 px-4 text-[0.88rem] gap-2',
  lg: 'h-12 px-6 text-[0.96rem] gap-2',
};
const ICON_SIZE = { sm: 14, md: 16, lg: 18 };

export const Button = forwardRef(function Button(
  { tone = 'secondary', size = 'md', icon, iconRight, loading = false, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      {...tap}
      disabled={disabled || loading}
      className={`inline-flex flex-none select-none items-center justify-center rounded-full font-semibold tracking-[-0.01em] transition-colors disabled:pointer-events-none disabled:opacity-40 ${TONE[tone] || TONE.secondary} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : icon ? <Icon name={icon} size={ICON_SIZE[size]} strokeWidth={2} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={ICON_SIZE[size]} strokeWidth={2} />}
    </motion.button>
  );
});

const ROUND = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-12 w-12' };
export const IconBtn = forwardRef(function IconBtn(
  { icon, label, size = 'md', tone = 'secondary', className = '', badge, iconSize, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      {...tap}
      aria-label={label}
      title={label}
      className={`relative grid flex-none place-items-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40 ${TONE[tone] || TONE.secondary} ${ROUND[size]} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={iconSize || ICON_SIZE[size] + 1} strokeWidth={2} />
      {badge ? (
        <span className="v-num absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warn px-1 text-[10.5px] font-bold text-[#241a02]">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </motion.button>
  );
});

export function Spinner({ size = 16, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`anim-spin inline-block flex-none rounded-full border-2 border-current border-t-transparent opacity-70 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

// ---------------------------------------------------------------------------
// Segmented control — the selection pill glides between options (a shared
// layout element, so it travels with the finger's choice instead of blinking).

export function Segmented({ value, onChange, options, className = '', size = 'md', full = false, ...rest }) {
  const id = useId();
  return (
    <div
      role="tablist"
      {...rest}
      className={`relative inline-flex flex-none items-center gap-0.5 rounded-full bg-fill p-[3px] ${full ? 'w-full' : ''} ${className}`}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="tab"
            aria-selected={on}
            onClick={() => onChange?.(o.value)}
            className={`relative flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors ${
              size === 'sm' ? 'h-7 px-2.5 text-[0.76rem]' : 'h-8 px-3.5 text-[0.82rem]'
            } ${full ? 'flex-1' : ''} ${on ? 'text-ink' : 'text-ink3 hover:text-ink2'}`}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={spring.snappy}
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_3px_rgba(0,0,0,0.18)]"
              />
            )}
            <span className="relative flex items-center gap-1.5 whitespace-nowrap">
              {o.icon && <Icon name={o.icon} size={13} strokeWidth={2} />}
              {o.label}
              {o.count ? <span className="v-num text-[0.72rem] font-medium text-ink3">{o.count}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// iOS switch.
export function Toggle({ on, onChange, label, disabled = false }) {
  return (
    <button
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className={`relative h-[31px] w-[51px] flex-none rounded-full transition-colors duration-200 disabled:opacity-40 ${on ? 'bg-accent' : 'bg-fill2'}`}
    >
      <motion.span
        initial={false}
        animate={{ x: on ? 20 : 0 }}
        transition={spring.snappy}
        className="absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.25)]"
      />
    </button>
  );
}

// Native <select> dressed as a pill — iPad and iPhone get the system picker.
export function Select({ value, onChange, options, className = '', label, ...rest }) {
  const cur = options.find((o) => String(o.value) === String(value));
  return (
    <label className={`relative inline-flex h-10 min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-fill pl-3.5 pr-2.5 text-[0.86rem] font-medium text-ink hover:bg-fill2 ${className}`}>
      <span className="min-w-0 flex-1 truncate">{cur?.label ?? label ?? ''}</span>
      <Icon name="chevronDown" size={14} className="flex-none text-ink3" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
        {...rest}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------

const DOT = {
  working: 'bg-accent',
  waiting: 'bg-warn',
  exited: 'bg-crit',
  done: 'bg-ink3',
  idle: 'bg-ink3',
};
export function Dot({ status = 'done', size = 8, pulse = true, className = '' }) {
  const live = status === 'working' && pulse;
  return (
    <span className={`relative inline-flex flex-none ${className}`} style={{ width: size, height: size }}>
      {live && <span className="anim-ping absolute inset-0 rounded-full bg-accent/60" />}
      <span className={`relative inline-block h-full w-full rounded-full ${DOT[status] || DOT.done}`} />
    </span>
  );
}

export function Empty({ icon = 'sparkles', title, hint, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center px-8 py-14 text-center ${className}`}>
      <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-fill text-ink3">
        <Icon name={icon} size={24} />
      </span>
      <div className="mt-4 text-[1.05rem] font-semibold tracking-tight text-ink">{title}</div>
      {hint && <p className="mt-1.5 max-w-[42ch] text-[0.86rem] leading-relaxed text-ink3">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Inset grouped list (Settings, sheets) — rows separated by hairlines that
// stop short of the leading edge, iOS style.
export function Group({ title, footer, children, className = '' }) {
  return (
    <section className={className}>
      {title && <div className="v-eyebrow mb-2 px-4">{title}</div>}
      <div className="v-card overflow-hidden">{children}</div>
      {footer && <p className="mt-2 px-4 text-[0.76rem] leading-relaxed text-ink3">{footer}</p>}
    </section>
  );
}
export function Row({ icon, iconTone = '', label, hint, children, onClick, last = false, className = '', ...rest }) {
  const Tag = onClick ? motion.button : 'div';
  const extra = onClick ? { whileTap: { backgroundColor: 'var(--v-fill)' }, onClick } : {};
  return (
    <Tag className={`flex min-h-[52px] w-full items-center gap-3 pl-4 text-left ${className}`} {...extra} {...rest}>
      {icon && (
        <span className={`grid h-8 w-8 flex-none place-items-center rounded-[10px] bg-fill text-ink2 ${iconTone}`}>
          <Icon name={icon} size={16} strokeWidth={2} />
        </span>
      )}
      <span className={`flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-2.5 pr-4 ${last ? '' : 'border-b border-hair'}`}>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.92rem] font-medium tracking-[-0.01em] text-ink">{label}</span>
          {hint && <span className="mt-0.5 block text-[0.76rem] leading-snug text-ink3">{hint}</span>}
        </span>
        {children !== undefined ? <span className="flex flex-none items-center gap-2">{children}</span> : null}
        {onClick && children === undefined && <Icon name="chevronRight" size={16} className="flex-none text-ink3" />}
      </span>
    </Tag>
  );
}

export function Chip({ on = false, onClick, children, className = '', ...rest }) {
  return (
    <motion.button
      {...tap}
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex h-8 flex-none items-center gap-1.5 rounded-full px-3 text-[0.8rem] font-medium transition-colors ${
        on ? 'bg-ink text-page' : 'bg-fill text-ink2 hover:bg-fill2 hover:text-ink'
      } ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// The composer: a field that grows with what you write, dictation that
// streams words in as you speak, send that only lights when there's something
// to send. Enter sends on a keyboard; Shift+Enter is a new line.

export function Composer({ onSend, placeholder = 'Message…', leading = null, canSendEmpty = false, autoFocus = false, className = '' }) {
  const [value, setValue] = useState('');
  const [rec, setRec] = useState(false);
  const session = useRef(null);
  const field = useRef(null);
  useEffect(() => () => session.current?.stop(), []);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  // Grow to fit, up to ~6 lines, without a layout jump.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  const mic = () => {
    if (session.current) return session.current.stop();
    const end = () => {
      session.current = null;
      setRec(false);
    };
    const s = dictate({ base: value, onText: setValue, onEnd: end, onError: end });
    if (s) {
      session.current = s;
      setRec(true);
    }
  };
  const submit = () => {
    session.current?.stop();
    const t = value.trim();
    if (!t && !canSendEmpty) return;
    if (onSend?.(t) === false) return; // refused (offline) — keep the words
    setValue('');
  };
  const can = !!value.trim() || canSendEmpty;

  return (
    <div className={`flex items-end gap-2 ${className}`}>
      {leading}
      <div className={`flex min-w-0 flex-1 items-end rounded-[22px] border bg-card transition-colors ${rec ? 'border-crit/50' : 'border-hair focus-within:border-hair2'}`}>
        <textarea
          ref={field}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="v-scroll block max-h-[168px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-[11px] pl-4 pr-1 text-[1rem] leading-[1.4] text-ink outline-none placeholder:text-ink3"
        />
        {speechSupported && (
          <motion.button
            {...tap}
            onClick={mic}
            aria-label="Dictate"
            aria-pressed={rec}
            className={`m-1 grid h-9 w-9 flex-none place-items-center rounded-full transition-colors ${rec ? 'bg-crit text-white' : 'text-ink3 hover:text-ink'}`}
          >
            <Icon name="mic" size={18} strokeWidth={2} />
          </motion.button>
        )}
      </div>
      <motion.button
        {...tap}
        onClick={submit}
        disabled={!can}
        aria-label="Send"
        animate={{ scale: can ? 1 : 0.92, opacity: can ? 1 : 0.35 }}
        transition={spring.snappy}
        className="grid h-11 w-11 flex-none place-items-center rounded-full bg-ink text-page disabled:pointer-events-none"
      >
        <Icon name="arrowUp" size={20} strokeWidth={2.4} />
      </motion.button>
    </div>
  );
}

// A search field with the clear button.
export function SearchField({ value, onChange, placeholder = 'Search', className = '', inputRef, ...rest }) {
  return (
    <div className={`relative ${className}`}>
      <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink3" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        enterKeyHint="search"
        className="v-field h-10 w-full pl-10 pr-9 text-[0.92rem]"
        {...rest}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-ink3 hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

// Two-tap confirm for destructive actions: the first tap arms it for 3 s.
export function useArm(ms = 3000) {
  const [armed, setArmed] = useState(false);
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  const fire = (fn) => {
    if (armed) {
      clearTimeout(t.current);
      setArmed(false);
      fn();
      return;
    }
    setArmed(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setArmed(false), ms);
  };
  return [armed, fire];
}
