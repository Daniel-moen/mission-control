// Frosted glass, the one surface. `raised` is the soft chip plane, `inset` is
// the near-opaque terminal/code plane (readability beats glass there).
export default function Surface({
  as: As = 'div',
  inset = false,
  raised = false,
  interactive = false,
  className = '',
  children,
  ...rest
}) {
  const plane = inset
    ? 'bg-term border border-glass-line rounded-xl2'
    : raised
      ? 'glass-soft rounded-xl2'
      : 'glass';
  return (
    <As
      className={`${plane} ${interactive ? 'glass-soft-hover cursor-pointer transition-colors' : ''} ${className}`}
      {...rest}
    >
      {children}
    </As>
  );
}
