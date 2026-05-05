import type { SVGProps } from 'react';

export function ChatToGate({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 720 320"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      preserveAspectRatio="xMidYMid meet"
      {...rest}
    >
      {/* phone */}
      <g transform="translate(40 50)">
        <rect width="140" height="240" rx="22" fill="#1a1f36" />
        <rect x="8" y="8" width="124" height="224" rx="16" fill="#f4ede2" />
        <rect x="56" y="14" width="28" height="4" rx="2" fill="#1a1f36" opacity="0.4" />
        {/* user bubble */}
        <g transform="translate(20 60)">
          <rect width="80" height="28" rx="14" fill="#d6624d" />
          <text x="14" y="18" fill="#f4ede2" fontFamily="Inter" fontSize="12" fontWeight="500">
            open
          </text>
        </g>
        {/* response */}
        <g transform="translate(20 100)">
          <rect width="100" height="28" rx="14" fill="#1a1f36" />
          <text x="10" y="18" fill="#f4ede2" fontFamily="Inter" fontSize="11">
            unlocked &middot; 7s
          </text>
        </g>
      </g>

      {/*
        Signal arc — exits the response bubble at the phone's right edge,
        passes through three checkpoint dots placed mathematically on the curve
        (t = 0.25 / 0.5 / 0.75), and terminates on the gate's keystone dot.

        Cubic Bézier: M(180,164) C(280,70) (480,70) (610,130)
      */}
      <path
        d="M180 164 C 280 70, 480 70, 610 130"
        fill="none"
        stroke="#1a1f36"
        strokeWidth="1.5"
        strokeDasharray="3 5"
      />

      {/* small terminator at phone end (anchors the arc to the bubble) */}
      <circle cx="180" cy="164" r="2.5" fill="#1a1f36" />

      {/* checkpoint dots, mathematically placed on the bezier above */}
      <g fontFamily="Inter" fontSize="10" fill="#1a1f36">
        {/* t = 0.25 → (272, 110) */}
        <g>
          <line x1="272" y1="110" x2="272" y2="92" stroke="#1a1f36" strokeWidth="1" opacity="0.4" />
          <circle cx="272" cy="110" r="6" fill="#c8a45c" stroke="#1a1f36" strokeWidth="1.5" />
          <text x="260" y="84" opacity="0.75" fontWeight="500">verify</text>
        </g>
        {/* t = 0.50 → (385, 88) */}
        <g>
          <line x1="385" y1="88" x2="385" y2="70" stroke="#1a1f36" strokeWidth="1" opacity="0.4" />
          <circle cx="385" cy="88" r="6" fill="#d6624d" stroke="#1a1f36" strokeWidth="1.5" />
          <text x="365" y="62" opacity="0.75" fontWeight="500">geofence</text>
        </g>
        {/* t = 0.75 → (502, 96) */}
        <g>
          <line x1="502" y1="96" x2="502" y2="78" stroke="#1a1f36" strokeWidth="1" opacity="0.4" />
          <circle cx="502" cy="96" r="6" fill="#2c5f4f" stroke="#1a1f36" strokeWidth="1.5" />
          <text x="488" y="70" opacity="0.75" fontWeight="500">device</text>
        </g>
      </g>

      {/* gate */}
      <g transform="translate(540 90)">
        {/* archway above gate */}
        <path
          d="M-10 100 V60 a80 40 0 0 1 160 0 V100"
          fill="none"
          stroke="#1a1f36"
          strokeWidth="2"
        />
        {/* gate frame */}
        <rect x="0" y="100" width="140" height="80" fill="none" stroke="#1a1f36" strokeWidth="2" />
        {/* gate bars */}
        {[20, 40, 60, 80, 100, 120].map((x) => (
          <line
            key={x}
            x1={x}
            y1="100"
            x2={x}
            y2="180"
            stroke="#1a1f36"
            strokeWidth="2"
          />
        ))}
        {/* keystone — also the arc terminator */}
        <circle cx="70" cy="40" r="6" fill="#d6624d" stroke="#1a1f36" strokeWidth="1.5" />
      </g>
    </svg>
  );
}
