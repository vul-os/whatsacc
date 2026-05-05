import type { SVGProps } from 'react';

export function Neighborhood({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 600 280"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      preserveAspectRatio="xMidYMid meet"
      {...rest}
    >
      {/* horizon line */}
      <line x1="0" y1="220" x2="600" y2="220" stroke="#1a1f36" strokeWidth="1.5" />

      {/* moon */}
      <circle cx="520" cy="60" r="18" fill="#c8a45c" opacity="0.9" />

      {/* complex wall with arched gate (centerpiece) */}
      <g transform="translate(220 100)">
        <rect x="-80" y="60" width="80" height="60" fill="#ece2d1" stroke="#1a1f36" strokeWidth="1.5" />
        <rect x="160" y="60" width="80" height="60" fill="#ece2d1" stroke="#1a1f36" strokeWidth="1.5" />
        {/* arched gate */}
        <path d="M0 120 V60 a80 60 0 0 1 160 0 V120 Z" fill="#1a1f36" />
        <path
          d="M16 120 V70 a64 50 0 0 1 128 0 V120"
          fill="none"
          stroke="#f4ede2"
          strokeWidth="1.5"
        />
        <circle cx="80" cy="74" r="3" fill="#d6624d" />
      </g>

      {/* houses on either side */}
      <g transform="translate(70 150)">
        <polygon points="0,30 30,0 60,30" fill="none" stroke="#1a1f36" strokeWidth="1.5" />
        <rect x="6" y="30" width="48" height="40" fill="#f4ede2" stroke="#1a1f36" strokeWidth="1.5" />
        <rect x="22" y="48" width="16" height="22" fill="#1a1f36" />
      </g>

      <g transform="translate(450 145)">
        <polygon points="0,35 36,0 72,35" fill="none" stroke="#1a1f36" strokeWidth="1.5" />
        <rect x="6" y="35" width="60" height="40" fill="#ece2d1" stroke="#1a1f36" strokeWidth="1.5" />
        <rect x="14" y="46" width="14" height="14" fill="#c8a45c" />
        <rect x="42" y="46" width="14" height="14" fill="#c8a45c" />
        <rect x="28" y="60" width="16" height="15" fill="#1a1f36" />
      </g>

      {/* trees */}
      <g transform="translate(170 180)">
        <line x1="0" y1="0" x2="0" y2="40" stroke="#1a1f36" strokeWidth="1.2" />
        <circle cx="0" cy="-4" r="14" fill="#4a6b58" />
      </g>
      <g transform="translate(420 184)">
        <line x1="0" y1="0" x2="0" y2="36" stroke="#1a1f36" strokeWidth="1.2" />
        <circle cx="0" cy="-2" r="12" fill="#4a6b58" />
      </g>

      {/* path */}
      <path
        d="M0 232 q 300 -20 600 0"
        fill="none"
        stroke="#1a1f36"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
    </svg>
  );
}
