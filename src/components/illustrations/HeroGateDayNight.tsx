import type { SVGProps } from 'react';

// Vertical members of the palisade gate — stiles (wider, at the ends) and the
// slim bars between them. Each rises into a spear finial.
const stiles = [
  { x: 112, w: 11 },
  { x: 349, w: 11 },
];
const bars = [134, 156, 178, 200, 222, 244, 266, 288, 310, 332];

// Night sky. Fixed positions + twinkle phase (no RNG — deterministic render).
const stars = [
  { x: 54, y: 64, r: 1.7, d: '0s' },
  { x: 104, y: 40, r: 1.2, d: '0.7s' },
  { x: 150, y: 92, r: 1.5, d: '1.4s' },
  { x: 38, y: 150, r: 1.2, d: '0.4s' },
  { x: 198, y: 56, r: 1.6, d: '1.0s' },
  { x: 92, y: 118, r: 1.1, d: '1.8s' },
  { x: 250, y: 38, r: 1.3, d: '0.6s' },
  { x: 430, y: 70, r: 1.6, d: '0.3s' },
  { x: 452, y: 132, r: 1.2, d: '1.1s' },
  { x: 398, y: 44, r: 1.1, d: '1.5s' },
  { x: 168, y: 158, r: 1.0, d: '2.0s' },
  { x: 72, y: 188, r: 1.3, d: '1.2s' },
];

/**
 * Hero scene — the gate is OPEN & sunlit by day (light mode) and DRAWN SHUT &
 * LOCKED under the moon by night (dark mode). The theme toggle operates it:
 * sun sets / moon rises, stars fade in, the palisade slides closed, a padlock
 * appears and clasps shut, the post lamp lights. It reverses on the way back.
 *
 * The metaphor IS the product — access, controlled. All choreography lives in
 * CSS (see `.gate-scene` in main.css) keyed off `:root[data-theme='dark']`, so
 * it animates smoothly on toggle and every colour tracks the theme tokens.
 */
export function HeroGateDayNight({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 520"
      className={`gate-scene ${className ?? ''}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="A gate standing open in daylight and drawn shut and locked at night"
      style={{ fontFamily: 'inherit' }}
      {...rest}
    >
      <defs>
        <radialGradient id="gdnSun" cx="42%" cy="40%" r="66%">
          <stop offset="0%" stopColor="var(--gold-soft)" />
          <stop offset="55%" stopColor="var(--gold)" />
          <stop offset="100%" stopColor="var(--terracotta)" />
        </radialGradient>
        <radialGradient id="gdnSunHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.5" />
          <stop offset="42%" stopColor="var(--gold)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gdnMoon" cx="37%" cy="33%" r="72%">
          <stop offset="0%" stopColor="var(--ink)" />
          <stop offset="62%" stopColor="var(--ink)" />
          <stop offset="100%" stopColor="var(--clay)" />
        </radialGradient>
        <radialGradient id="gdnMoonHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.28" />
          <stop offset="55%" stopColor="var(--gold)" stopOpacity="0.07" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gdnGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.42" />
          <stop offset="50%" stopColor="var(--gold-soft)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--gold-soft)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="gdnPath" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="gdnLamp" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold-soft)" stopOpacity="0.9" />
          <stop offset="38%" stopColor="var(--gold)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ── celestial: sun (day) ↔ moon (night) ─────────────────────── */}
      <g className="gs-sun">
        <circle cx="308" cy="150" r="190" fill="url(#gdnSunHalo)" />
        <g className="gs-sun-rays" stroke="var(--gold)" strokeWidth="2.25" strokeLinecap="round">
          {Array.from({ length: 12 }, (_, i) => (i * 360) / 12).map((deg) => (
            <line key={deg} x1="308" y1="78" x2="308" y2="60" transform={`rotate(${deg} 308 150)`} />
          ))}
        </g>
        <circle cx="308" cy="150" r="58" fill="url(#gdnSun)" />
        <circle cx="288" cy="130" r="15" fill="var(--gold-soft)" opacity="0.5" />
      </g>
      <g className="gs-moon">
        <circle cx="308" cy="150" r="172" fill="url(#gdnMoonHalo)" />
        <circle cx="308" cy="150" r="54" fill="url(#gdnMoon)" />
        <ellipse cx="286" cy="132" rx="12" ry="10" fill="var(--clay)" opacity="0.45" />
        <ellipse cx="326" cy="166" rx="9" ry="8" fill="var(--clay)" opacity="0.4" />
        <ellipse cx="300" cy="176" rx="6" ry="5.5" fill="var(--clay)" opacity="0.35" />
        <ellipse cx="322" cy="126" rx="5" ry="4" fill="var(--clay)" opacity="0.4" />
      </g>

      {/* ── stars (night) ───────────────────────────────────────────── */}
      <g className="gs-stars" fill="var(--ink)">
        {stars.map((s) => (
          <circle key={`${s.x}-${s.y}`} className="gs-star" cx={s.x} cy={s.y} r={s.r} style={{ animationDelay: s.d }} />
        ))}
      </g>

      {/* ── warm daylight: welcome glow + driveway (fades at night) ──── */}
      <g className="gs-day">
        <ellipse cx="240" cy="332" rx="150" ry="120" fill="url(#gdnGlow)" />
        <path d="M132 404 L348 404 L430 488 L50 488 Z" fill="url(#gdnPath)" />
        <path d="M240 408 L240 484" stroke="var(--gold)" strokeWidth="2.5" strokeDasharray="3 14" strokeLinecap="round" opacity="0.4" />
      </g>

      {/* ── ground ──────────────────────────────────────────────────── */}
      <line x1="18" y1="406" x2="462" y2="406" stroke="var(--ink)" strokeOpacity="0.16" strokeWidth="2" />

      {/* ── the gate (palisade) — slides open/shut ──────────────────── */}
      <g className="gs-gate">
        {/* spear-topped verticals */}
        {[...stiles.map((s) => ({ ...s })), ...bars.map((x) => ({ x, w: 6 }))].map(({ x, w }) => (
          <g key={x} fill="var(--ink)" opacity="0.85">
            <rect x={x} y="230" width={w} height="150" rx={w / 2} />
            <path d={`M${x - 1.5} 232 L${x + w + 1.5} 232 L${x + w / 2} 214 Z`} />
          </g>
        ))}
        {/* rails */}
        <rect x="108" y="250" width="252" height="11" rx="3" fill="var(--ink)" opacity="0.92" />
        <rect x="108" y="356" width="252" height="11" rx="3" fill="var(--ink)" opacity="0.92" />
        {/* warm accent under the top rail */}
        <rect x="108" y="263" width="252" height="2.5" rx="1" fill="var(--terracotta)" opacity="0.55" />
      </g>

      {/* ── gateposts (warm stone) — drawn over the parked gate ─────── */}
      {[{ x: 0 }, { x: 360 }].map(({ x }, i) => (
        <g key={x}>
          <rect x={x} y="198" width="120" height="208" fill="var(--clay)" />
          {/* inner-edge light / shadow for depth */}
          <rect x={i === 0 ? 110 : 360} y="198" width="10" height="208" fill={i === 0 ? 'var(--paper)' : 'var(--ink)'} opacity={i === 0 ? 0.1 : 0.08} />
          {/* stone courses */}
          <line x1={x} y1="252" x2={x + 120} y2="252" stroke="var(--ink)" strokeOpacity="0.07" strokeWidth="2" />
          <line x1={x} y1="318" x2={x + 120} y2="318" stroke="var(--ink)" strokeOpacity="0.07" strokeWidth="2" />
          {/* base shadow */}
          <rect x={x} y="398" width="120" height="8" fill="var(--ink)" opacity="0.12" />
          {/* capstone */}
          <rect x={x - 4} y="182" width="128" height="18" rx="3" fill="var(--clay)" />
          <rect x={x - 4} y="182" width="128" height="5" rx="2" fill="var(--ink)" opacity="0.16" />
        </g>
      ))}

      {/* ── post lamp — lights at night ─────────────────────────────── */}
      <circle className="gs-lamp-glow" cx="372" cy="236" r="44" fill="url(#gdnLamp)" />
      <g>
        <rect x="366" y="220" width="12" height="6" rx="2" fill="var(--ink)" opacity="0.6" />
        <path d="M364 250 L380 250 L377 228 L367 228 Z" fill="var(--ink)" opacity="0.55" />
        <path className="gs-lamp-core" d="M367 247 L377 247 L375 231 L369 231 Z" />
      </g>

      {/* ── padlock — appears + clasps once the gate is shut (night) ─── */}
      <g className="gs-lock">
        <path
          className="gs-shackle"
          d="M323 304 L323 290 A14 14 0 0 1 351 290 L351 304"
          fill="none"
          stroke="var(--terracotta)"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <rect x="314" y="302" width="46" height="34" rx="6" fill="var(--ink)" />
        <circle cx="337" cy="316" r="4.5" fill="var(--gold-soft)" />
        <rect x="335" y="318" width="4" height="10" rx="2" fill="var(--gold-soft)" />
      </g>

      {/* ── "Gate opened" message — daylight only ───────────────────── */}
      <g className="gs-day">
        <rect x="34" y="96" width="172" height="48" rx="16" fill="var(--paper-cool)" stroke="var(--ink)" strokeOpacity="0.12" strokeWidth="1.5" />
        {/* open padlock glyph */}
        <g stroke="var(--signal)" strokeWidth="2.2" fill="none" strokeLinecap="round">
          <rect x="52" y="116" width="22" height="16" rx="3" fill="var(--signal)" fillOpacity="0.14" />
          <path d="M57 116 v-5 a7 7 0 0 1 14 0 v2" />
        </g>
        <text x="86" y="120" fontSize="15" fontWeight="600" fill="var(--ink)">Gate opened</text>
        <text x="86" y="137" fontSize="11" fill="var(--ink)" opacity="0.5">07:42</text>
        <g stroke="var(--signal)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M150 131 l3.5 4 l8 -10" />
          <path d="M158 131 l3.5 4 l8 -10" />
        </g>
      </g>
    </svg>
  );
}
