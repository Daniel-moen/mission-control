export default function Field({ label, hint, className = '', children }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="label mb-1.5 block">{label}</span>}
      {children}
      {hint && <span className="mt-1.5 block text-[11.5px] leading-snug text-ink3">{hint}</span>}
    </label>
  );
}
