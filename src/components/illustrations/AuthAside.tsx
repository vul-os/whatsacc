import type { SVGProps } from 'react';

// Aside artwork for the Login / Signup / Forgot / Reset pages.
// A keyhole framed by an arch, with a chat-bubble badge sliding through.
// Same line weight + palette as ArchMark / HeroPortal so it sits in the
// same family.
export function AuthAside({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 720"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      preserveAspectRatio="xMidYMid meet"
      {...rest}
    >
      <defs>
        <linearGradient id="aa-paper" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f8f3ea" stopOpacity="0.10" />
          <stop offset="1" stopColor="#ece2d1" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="aa-keyhole" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#d6624d" stopOpacity="1" />
          <stop offset="1" stopColor="#b14d3a" stopOpacity="1" />
        </linearGradient>
        <pattern id="aa-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill="#f4ede2" opacity="0.10" />
        </pattern>
        <radialGradient id="aa-glow" cx="0.5" cy="0.4" r="0.6">
          <stop offset="0" stopColor="#d6624d" stopOpacity="0.22" />
          <stop offset="1" stopColor="#d6624d" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* warm glow behind the arch */}
      <ellipse cx="240" cy="290" rx="220" ry="260" fill="url(#aa-glow)" />

      {/* arched cartouche outline */}
      <path
        d="M80 560 V300 a160 160 0 0 1 320 0 V560 Z"
        fill="url(#aa-paper)"
        stroke="#f4ede2"
        strokeOpacity="0.35"
        strokeWidth="2"
      />
      <path
        d="M80 560 V300 a160 160 0 0 1 320 0 V560 Z"
        fill="url(#aa-dots)"
      />

      {/* nested inner arch — the threshold */}
      <path
        d="M150 560 V305 a90 90 0 0 1 180 0 V560 Z"
        fill="none"
        stroke="#f4ede2"
        strokeOpacity="0.30"
        strokeWidth="1.5"
      />

      {/* keyhole, centred and filled in terracotta */}
      <g transform="translate(240 320)">
        <circle r="34" fill="url(#aa-keyhole)" />
        <circle r="34" fill="none" stroke="#f4ede2" strokeOpacity="0.55" strokeWidth="1.5" />
        <rect x="-8" y="20" width="16" height="60" rx="3" fill="url(#aa-keyhole)" />
        <rect
          x="-8"
          y="20"
          width="16"
          height="60"
          rx="3"
          fill="none"
          stroke="#f4ede2"
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <circle r="8" fill="#1a1f36" />
      </g>

      {/* horizontal threshold rule */}
      <line
        x1="60"
        y1="560"
        x2="420"
        y2="560"
        stroke="#f4ede2"
        strokeOpacity="0.45"
        strokeWidth="2"
      />

      {/* chat bubble badge — the WhatsApp message that opened the gate */}
      <g transform="translate(110 600)">
        <rect width="172" height="82" rx="22" fill="#f4ede2" />
        <path d="M28 82 L28 98 L48 82 Z" fill="#f4ede2" />
        <text
          x="22"
          y="36"
          fill="#1a1f36"
          fontFamily="Inter, system-ui, sans-serif"
          fontSize="14"
          fontWeight={500}
          letterSpacing="0.3"
        >
          open
        </text>
        <rect x="22" y="48" width="48" height="3" rx="1.5" fill="#d6624d" />
        <rect x="22" y="58" width="120" height="2" rx="1" fill="#1a1f36" opacity="0.20" />
        <rect x="22" y="64" width="84" height="2" rx="1" fill="#1a1f36" opacity="0.15" />
      </g>

      {/* small ringing dot — signal */}
      <g transform="translate(380 130)">
        <circle r="22" fill="none" stroke="#c8a45c" strokeOpacity="0.5" strokeWidth="1.5" />
        <circle r="14" fill="none" stroke="#c8a45c" strokeOpacity="0.7" strokeWidth="1.5" />
        <circle r="6" fill="#c8a45c" />
      </g>

      {/* tiny editorial tick marks */}
      <g stroke="#f4ede2" strokeOpacity="0.4" strokeWidth="1.5">
        <line x1="60" y1="120" x2="80" y2="120" />
        <line x1="60" y1="200" x2="74" y2="200" />
        <line x1="406" y1="200" x2="420" y2="200" />
        <line x1="400" y1="280" x2="420" y2="280" />
      </g>
    </svg>
  );
}
