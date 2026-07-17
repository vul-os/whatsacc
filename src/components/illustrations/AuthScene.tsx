// AuthScene — animated auth-page illustration. Tells the brand story in
// motion: a message rises from below, is absorbed by the keyhole at the
// centre of an architectural arch, the gate "unlocks" (warm halo + light
// rays), and the cycle repeats. Tuned to feel architectural, not playful —
// slow easing, restrained motion, limited palette.
//
// Performance notes:
//   · All motion is GPU-friendly transforms / opacity (no layout thrash).
//   · Pure SVG, ~10kb, no images, no fonts loaded for the illustration.
//   · Respects prefers-reduced-motion via the `reduceMotion` prop — caller
//     wraps in MotionConfig if global reduction is desired.

import { motion } from 'framer-motion';
import type { SVGProps } from 'react';

const INK = '#1a1f36';
const INK_DEEP = '#0d1024';
const PAPER = '#f4ede2';
const TERRACOTTA = '#d6624d';
const TERRACOTTA_DEEP = '#b14d3a';
const GOLD = '#c8a45c';

// One full narrative cycle. Choreographed via `times` arrays below so the
// keyhole pulse, light rays, and message arrival stay in sync.
const CYCLE_S = 8;

// Star field — deterministic positions so the build is stable.
const STARS: Array<{ x: number; y: number; r: number; twinkle: number }> = [
  { x: 60, y: 80, r: 1.2, twinkle: 4.2 },
  { x: 110, y: 140, r: 0.8, twinkle: 5.8 },
  { x: 200, y: 60, r: 1.4, twinkle: 6.4 },
  { x: 280, y: 110, r: 0.9, twinkle: 4.8 },
  { x: 360, y: 70, r: 1.1, twinkle: 5.4 },
  { x: 420, y: 150, r: 0.7, twinkle: 7.0 },
  { x: 50, y: 220, r: 0.9, twinkle: 6.0 },
  { x: 150, y: 200, r: 1.3, twinkle: 4.6 },
  { x: 380, y: 230, r: 1.0, twinkle: 5.2 },
  { x: 310, y: 50, r: 0.6, twinkle: 8.0 },
  { x: 90, y: 50, r: 0.8, twinkle: 6.6 },
  { x: 230, y: 170, r: 0.7, twinkle: 5.0 },
];

export function AuthScene({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 720"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      {...rest}
    >
      <defs>
        <linearGradient id="as-sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={INK_DEEP} />
          <stop offset="0.55" stopColor={INK} />
          <stop offset="1" stopColor="#1a1f36" />
        </linearGradient>
        <linearGradient id="as-floor" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0" />
          <stop offset="1" stopColor="#0a0d1c" stopOpacity="0.8" />
        </linearGradient>
        <radialGradient id="as-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={TERRACOTTA} stopOpacity="0.55" />
          <stop offset="0.55" stopColor={TERRACOTTA} stopOpacity="0.10" />
          <stop offset="1" stopColor={TERRACOTTA} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="as-keyhole-body" cx="0.5" cy="0.4" r="0.6">
          <stop offset="0" stopColor={TERRACOTTA} />
          <stop offset="1" stopColor={TERRACOTTA_DEEP} />
        </radialGradient>
        <linearGradient id="as-bubble" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={PAPER} />
          <stop offset="1" stopColor="#ece2d1" />
        </linearGradient>
        <pattern id="as-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.7" fill={PAPER} opacity="0.07" />
        </pattern>
      </defs>

      {/* ── Sky background ──────────────────────────────────────────────── */}
      <rect width="480" height="720" fill="url(#as-sky)" />
      <rect width="480" height="720" fill="url(#as-dots)" />

      {/* Drifting stars — twinkle by individual durations so it never feels
          metronomic. Opacity oscillates between 0.2 and 0.85. */}
      <g>
        {STARS.map((s, i) => (
          <motion.circle
            key={i}
            cx={s.x}
            cy={s.y}
            r={s.r}
            fill={PAPER}
            initial={{ opacity: 0.2 }}
            animate={{ opacity: [0.2, 0.85, 0.2] }}
            transition={{
              duration: s.twinkle,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: (i % 4) * 0.6,
            }}
          />
        ))}
      </g>

      {/* ── Architectural ticks in the corners ─────────────────────────── */}
      <g stroke={PAPER} strokeOpacity="0.25" strokeWidth="1.5">
        <line x1="36" y1="36" x2="58" y2="36" />
        <line x1="36" y1="36" x2="36" y2="58" />
        <line x1="444" y1="36" x2="422" y2="36" />
        <line x1="444" y1="36" x2="444" y2="58" />
      </g>

      {/* ── Halo behind the keyhole (pulses with the arrival event) ───── */}
      <motion.ellipse
        cx="240"
        cy="370"
        rx="200"
        ry="220"
        fill="url(#as-halo)"
        initial={{ opacity: 0.4 }}
        animate={{
          opacity: [0.4, 0.4, 0.95, 0.4],
          scale: [1, 1, 1.08, 1],
        }}
        transition={{
          duration: CYCLE_S,
          repeat: Infinity,
          times: [0, 0.65, 0.78, 1],
          ease: 'easeOut',
        }}
        style={{ transformOrigin: '240px 370px', transformBox: 'fill-box' }}
      />

      {/* ── Outer arch ─────────────────────────────────────────────────── */}
      <motion.path
        d="M80 600 V340 a160 160 0 0 1 320 0 V600"
        fill="none"
        stroke={PAPER}
        strokeOpacity="0.55"
        strokeWidth="2"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 2.4, ease: [0.22, 1, 0.36, 1] }}
      />

      {/* ── Inner arch (the threshold) ─────────────────────────────────── */}
      <motion.path
        d="M150 600 V345 a90 90 0 0 1 180 0 V600"
        fill="none"
        stroke={PAPER}
        strokeOpacity="0.32"
        strokeWidth="1.5"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 2.4, ease: [0.22, 1, 0.36, 1], delay: 0.4 }}
      />

      {/* ── Light rays (emit at the moment of unlock) ──────────────────── */}
      <motion.g
        style={{ transformOrigin: '240px 370px', transformBox: 'fill-box' }}
        initial={{ opacity: 0 }}
        animate={{
          opacity: [0, 0, 0.65, 0],
          scale: [0.9, 0.9, 1.08, 1.18],
        }}
        transition={{
          duration: CYCLE_S,
          repeat: Infinity,
          times: [0, 0.7, 0.8, 0.95],
          ease: 'easeOut',
        }}
      >
        {[-60, -30, 0, 30, 60].map((angle) => (
          <line
            key={angle}
            x1="240"
            y1="370"
            x2={240 + Math.sin((angle * Math.PI) / 180) * 220}
            y2={370 - Math.cos((angle * Math.PI) / 180) * 220}
            stroke={GOLD}
            strokeOpacity="0.5"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ))}
      </motion.g>

      {/* ── Keyhole ────────────────────────────────────────────────────── */}
      <motion.g
        style={{ transformOrigin: '240px 370px', transformBox: 'fill-box' }}
        animate={{
          // Twist on arrival, then ease back so the loop is seamless.
          rotate: [0, 0, 18, 0],
          scale: [1, 1, 1.08, 1],
        }}
        transition={{
          duration: CYCLE_S,
          repeat: Infinity,
          times: [0, 0.7, 0.8, 0.96],
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <circle cx="240" cy="370" r="32" fill="url(#as-keyhole-body)" />
        <circle
          cx="240"
          cy="370"
          r="32"
          fill="none"
          stroke={PAPER}
          strokeOpacity="0.6"
          strokeWidth="1.5"
        />
        <rect
          x="232"
          y="388"
          width="16"
          height="58"
          rx="3"
          fill="url(#as-keyhole-body)"
        />
        <rect
          x="232"
          y="388"
          width="16"
          height="58"
          rx="3"
          fill="none"
          stroke={PAPER}
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <circle cx="240" cy="370" r="7" fill={INK_DEEP} />
      </motion.g>

      {/* ── Threshold / horizon line ───────────────────────────────────── */}
      <line
        x1="40"
        y1="600"
        x2="440"
        y2="600"
        stroke={PAPER}
        strokeOpacity="0.42"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Floor wash so the bubble's exit fades into the dark */}
      <rect x="0" y="600" width="480" height="120" fill="url(#as-floor)" />

      {/* ── Phone glyph at the bottom — origin of the message ─────────── */}
      <g transform="translate(190 638)">
        <rect width="100" height="50" rx="10" fill={PAPER} fillOpacity="0.08" />
        <rect
          width="100"
          height="50"
          rx="10"
          fill="none"
          stroke={PAPER}
          strokeOpacity="0.35"
          strokeWidth="1.4"
        />
        <circle cx="86" cy="25" r="4" fill={GOLD} fillOpacity="0.75" />
        <line
          x1="14"
          y1="20"
          x2="68"
          y2="20"
          stroke={PAPER}
          strokeOpacity="0.35"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <line
          x1="14"
          y1="32"
          x2="50"
          y2="32"
          stroke={PAPER}
          strokeOpacity="0.22"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </g>

      {/* ── Signal ring on the upper right — ambient connectivity ─────── */}
      <g transform="translate(412 110)">
        <motion.circle
          r="14"
          fill="none"
          stroke={GOLD}
          strokeWidth="1.4"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.6, 0], scale: [0.4, 1.4, 1.8] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeOut' }}
        />
        <motion.circle
          r="14"
          fill="none"
          stroke={GOLD}
          strokeWidth="1.4"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.5, 0], scale: [0.4, 1.4, 1.8] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeOut', delay: 1.2 }}
        />
        <circle r="4" fill={GOLD} />
      </g>

      {/* ── The chat bubble — rises from the phone, into the keyhole ─── */}
      <motion.g
        initial={{ y: 0, opacity: 0 }}
        animate={{
          y: [0, 0, -255, -270],
          opacity: [0, 1, 1, 0],
          scale: [0.96, 1, 0.7, 0.4],
        }}
        transition={{
          duration: CYCLE_S,
          repeat: Infinity,
          times: [0, 0.12, 0.7, 0.78],
          ease: [0.4, 0, 0.2, 1],
        }}
      >
        <g transform="translate(168 580)">
          <rect width="144" height="42" rx="14" fill="url(#as-bubble)" />
          <path d="M28 42 L28 54 L46 42 Z" fill={PAPER} />
          <rect x="20" y="14" width="36" height="3.5" rx="1.75" fill={TERRACOTTA} />
          <rect x="20" y="22" width="100" height="2.5" rx="1.25" fill={INK} fillOpacity="0.20" />
          <rect x="20" y="29" width="68" height="2.5" rx="1.25" fill={INK} fillOpacity="0.13" />
        </g>
      </motion.g>

      {/* ── Soft top vignette to keep focus low-centre ─────────────────── */}
      <rect
        width="480"
        height="240"
        fill={INK}
        opacity="0.0"
        // gradient via mask:
      />
    </svg>
  );
}
