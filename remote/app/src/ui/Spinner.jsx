// Loading indicator. A ring, not a bouncing dot parade.
export default function Spinner({ size = 16, className = '' }) {
  return (
    <span
      className={`anim-spin inline-block flex-none rounded-full border-2 border-current border-t-transparent opacity-70 ${className}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
