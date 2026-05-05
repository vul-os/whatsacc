import type { SVGProps } from 'react';

export function DevicePairing({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 280"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...rest}
    >
      {/* controller box */}
      <g transform="translate(160 80)">
        <rect width="160" height="120" rx="10" fill="#1a1f36" />
        <rect x="10" y="10" width="140" height="50" rx="4" fill="#2c3350" />
        {/* led */}
        <circle cx="30" cy="35" r="5" fill="#d6624d" />
        <circle cx="30" cy="35" r="9" fill="none" stroke="#d6624d" strokeOpacity="0.4" />
        {/* label */}
        <text x="46" y="40" fontFamily="JetBrains Mono" fontSize="11" fill="#f4ede2">
          ACC-01
        </text>
        {/* cable terminals */}
        <rect x="20" y="80" width="20" height="20" fill="#c8a45c" />
        <rect x="50" y="80" width="20" height="20" fill="#c8a45c" />
        <rect x="80" y="80" width="20" height="20" fill="#c8a45c" />
        <rect x="110" y="80" width="20" height="20" fill="#c8a45c" />
        {/* cable */}
        <path
          d="M30 100 q -20 30 -40 50"
          stroke="#1a1f36"
          strokeWidth="2"
          fill="none"
        />
      </g>

      {/* signal waves left */}
      <g transform="translate(120 140)" stroke="#1a1f36" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M0 0 q -10 -10 -20 0" />
        <path d="M0 0 q -16 -16 -32 0" opacity="0.6" />
        <path d="M0 0 q -22 -22 -44 0" opacity="0.3" />
      </g>

      {/* signal waves right */}
      <g transform="translate(360 140)" stroke="#1a1f36" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M0 0 q 10 -10 20 0" />
        <path d="M0 0 q 16 -16 32 0" opacity="0.6" />
        <path d="M0 0 q 22 -22 44 0" opacity="0.3" />
      </g>

      {/* QR code (decorative) */}
      <g transform="translate(380 170)">
        <rect width="60" height="60" fill="#f4ede2" stroke="#1a1f36" strokeWidth="1" />
        {Array.from({ length: 25 }).map((_, i) => {
          const x = (i % 5) * 11 + 4;
          const y = Math.floor(i / 5) * 11 + 4;
          const filled = [0, 1, 4, 5, 6, 10, 13, 17, 18, 21, 24].includes(i);
          return filled ? <rect key={i} x={x} y={y} width="9" height="9" fill="#1a1f36" /> : null;
        })}
      </g>

      {/* phone */}
      <g transform="translate(20 100)">
        <rect width="80" height="140" rx="12" fill="#1a1f36" />
        <rect x="5" y="5" width="70" height="130" rx="9" fill="#f4ede2" />
        <text x="14" y="34" fontFamily="Inter" fontSize="10" fill="#1a1f36" fontWeight="500">
          Pair device
        </text>
        <rect x="14" y="44" width="50" height="2" fill="#1a1f36" opacity="0.2" />
        <rect x="14" y="60" width="52" height="32" rx="4" fill="#d6624d" />
        <text x="22" y="80" fontFamily="Inter" fontSize="9" fill="#f4ede2">
          scan code
        </text>
      </g>
    </svg>
  );
}
