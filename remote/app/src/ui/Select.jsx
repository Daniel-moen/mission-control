import Icon from './Icon.jsx';

// Native <select>, styled. Deliberately native-first: on iPad/iPhone the system
// picker is faster, accessible and never fights the page's scroll containers.
export default function Select({ options = [], value, onChange, placeholder, className = '', ...rest }) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        className="glass-soft h-10 w-full cursor-pointer appearance-none rounded-xl2 pl-3.5 pr-9 text-[13.5px] text-ink outline-none transition-colors hover:border-glass-line2 focus:border-glass-line2"
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.hint ? `${o.label} — ${o.hint}` : o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevronDown"
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink3"
      />
    </div>
  );
}
