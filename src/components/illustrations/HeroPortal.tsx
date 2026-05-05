import type { SVGProps } from 'react';

export function HeroPortal({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 600"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...rest}
    >
      <defs>
        <linearGradient id="paperGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f8f3ea" />
          <stop offset="1" stopColor="#ece2d1" />
        </linearGradient>
        <linearGradient id="archShade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1a1f36" stopOpacity="0.05" />
          <stop offset="1" stopColor="#1a1f36" stopOpacity="0.18" />
        </linearGradient>
        <pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill="#1a1f36" opacity="0.18" />
        </pattern>
      </defs>

      {/* base panel — arched cartouche */}
      <rect x="20" y="20" width="440" height="540" rx="220" fill="url(#paperGrad)" />
      <rect x="20" y="20" width="440" height="540" rx="220" fill="url(#dots)" />

      {/* outer arch — the "portal" */}
      <path
        d="M100 520 V280 a140 140 0 0 1 280 0 V520 Z"
        fill="url(#archShade)"
        stroke="#1a1f36"
        strokeWidth="2"
      />

      {/* inner arch — the "doorway" */}
      <path
        d="M160 520 V280 a80 80 0 0 1 160 0 V520 Z"
        fill="#f4ede2"
        stroke="#1a1f36"
        strokeWidth="2"
      />

      {/* keystone dot — the brand accent */}
      <circle cx="240" cy="200" r="6" fill="#d6624d" />

      {/* horizontal rule line — the threshold */}
      <line x1="40" y1="520" x2="440" y2="520" stroke="#1a1f36" strokeWidth="2" />

      {/* chat bubble emerging from the portal */}
      <g transform="translate(176 300)">
        <rect width="128" height="76" rx="20" fill="#1a1f36" />
        <path d="M24 76 L24 92 L42 76 Z" fill="#1a1f36" />
        <text
          x="20"
          y="34"
          fill="#f4ede2"
          fontFamily="Inter, sans-serif"
          fontSize="14"
          fontWeight={500}
        >
          open
        </text>
        <rect x="20" y="46" width="50" height="3" rx="1.5" fill="#d6624d" />
        <rect x="20" y="54" width="80" height="2" rx="1" fill="#f4ede2" opacity="0.4" />
      </g>

      {/* sun / moon disc — editorial detail */}
      <circle cx="378" cy="100" r="34" fill="#c8a45c" opacity="0.85" />
      <circle cx="378" cy="100" r="34" fill="none" stroke="#1a1f36" strokeWidth="1.5" />
    </svg>
  );
}
