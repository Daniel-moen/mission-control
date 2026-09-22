export default function Kbd({ children, className = '' }) {
  return (
    <kbd
      className={`glass-soft inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-md px-1 font-sans text-[10.5px] font-medium leading-none text-ink2 ${className}`}
    >
      {children}
    </kbd>
  );
}
