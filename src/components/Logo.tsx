import Link from "next/link";

// The logomark (an antenna, a box with two eyes, an arrow) and the "awml" logotype.
export function Logo() {
  return (
    <Link href="/" className="brand">
      <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M20 14 V8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="20" cy="6" r="3.5" fill="currentColor" />
        <rect x="5" y="15" width="30" height="30" rx="8" fill="none" stroke="currentColor" strokeWidth="4" />
        <circle cx="15" cy="27" r="3" fill="currentColor" />
        <circle cx="25" cy="27" r="3" fill="currentColor" />
        <path d="M35 30 H50" stroke="currentColor" strokeWidth="4.8" />
        <path d="M47 22.8 L56 30 L47 37.2 Z" fill="currentColor" />
      </svg>
      <span>awml</span>
    </Link>
  );
}
