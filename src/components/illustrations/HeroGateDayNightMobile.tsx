import type { CSSProperties, SVGProps } from 'react';

// Mobile BACKDROP composition: a tall, atmospheric scene meant to sit behind
// the hero copy. The gate is small and set back at the bottom (posts framed
// with margin, not jammed to the edges), and the sky above is transparent — so
// it's just the page, and the headline/dek read cleanly on top. The gate slides
// within a fixed clip frame, so "open" simply slides it out of view behind the
// left post — no parked-gate peeking. Shares the choreography in main.css
// (`.gate-scene` / `.gs-*`); only the transform ANCHORS differ (CSS vars below).

const stiles = [
  { x: 100, w: 8 },
  { x: 288, w: 8 },
];
const bars = [122, 146, 170, 194, 218, 242, 266];

const stars = [
  { x: 54, y: 96, r: 1.6, d: '0s' },
  { x: 120, y: 64, r: 1.1, d: '0.7s' },
  { x: 196, y: 110, r: 1.3, d: '1.4s' },
  { x: 300, y: 80, r: 1.4, d: '0.4s' },
  { x: 350, y: 150, r: 1.1, d: '1.1s' },
  { x: 40, y: 190, r: 1.2, d: '0.3s' },
  { x: 250, y: 56, r: 1.2, d: '1.7s' },
  { x: 330, y: 240, r: 1.0, d: '1.0s' },
  { x: 80, y: 300, r: 1.1, d: '2.0s' },
];

const anchors = {
  '--gs-cx': '270px',
  '--gs-cy': '482px',
  '--gs-rise': '50px',
  // slide far enough that the gate's right edge clears x=0 (rail spans 96→300),
  // so it exits the SVG viewport entirely when open — no peeking, no mask.
  '--gs-gate-open': '-312px',
  '--gs-shx': '282px',
  '--gs-shy': '586px',
  fontFamily: 'inherit',
} as CSSProperties;

export function HeroGateDayNightMobile({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 400 720"
      className={`gate-scene ${className ?? ''}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="A gate standing open in daylight and drawn shut and locked at night"
      style={anchors}
      {...rest}
    >
      <defs>
        <radialGradient id="gmSun" cx="42%" cy="40%" r="66%">
          <stop offset="0%" stopColor="var(--gold-soft)" />
          <stop offset="55%" stopColor="var(--gold)" />
          <stop offset="100%" stopColor="var(--terracotta)" />
        </radialGradient>
        <radialGradient id="gmSunHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.45" />
          <stop offset="42%" stopColor="var(--gold)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gmMoon" cx="37%" cy="33%" r="72%">
          <stop offset="0%" stopColor="var(--ink)" />
          <stop offset="62%" stopColor="var(--ink)" />
          <stop offset="100%" stopColor="var(--clay)" />
        </radialGradient>
        <radialGradient id="gmMoonHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.24" />
          <stop offset="55%" stopColor="var(--gold)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gmGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.38" />
          <stop offset="50%" stopColor="var(--gold-soft)" stopOpacity="0.1" />
          <stop offset="100%" stopColor="var(--gold-soft)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="gmPath" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="gmLamp" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold-soft)" stopOpacity="0.85" />
          <stop offset="38%" stopColor="var(--gold)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ── celestial: sun (day) ↔ moon (night), set just above the gate ── */}
      <g className="gs-sun">
        <circle cx="270" cy="482" r="116" fill="url(#gmSunHalo)" />
        <g className="gs-sun-rays" stroke="var(--gold)" strokeWidth="2.25" strokeLinecap="round">
          {Array.from({ length: 12 }, (_, i) => (i * 360) / 12).map((deg) => (
            <line key={deg} x1="270" y1="428" x2="270" y2="414" transform={`rotate(${deg} 270 482)`} />
          ))}
        </g>
        <circle cx="270" cy="482" r="44" fill="url(#gmSun)" />
        <circle cx="254" cy="466" r="12" fill="var(--gold-soft)" opacity="0.5" />
      </g>
      <g className="gs-moon">
        <circle cx="270" cy="482" r="106" fill="url(#gmMoonHalo)" />
        <circle cx="270" cy="482" r="42" fill="url(#gmMoon)" />
        <ellipse cx="252" cy="466" rx="10" ry="8.5" fill="var(--clay)" opacity="0.45" />
        <ellipse cx="286" cy="496" rx="7.5" ry="6.5" fill="var(--clay)" opacity="0.4" />
        <ellipse cx="266" cy="504" rx="5" ry="4.5" fill="var(--clay)" opacity="0.35" />
        <ellipse cx="284" cy="462" rx="4.5" ry="3.5" fill="var(--clay)" opacity="0.4" />
      </g>

      {/* ── stars (night) — subtle, behind the copy ─────────────────── */}
      <g className="gs-stars" fill="var(--ink)">
        {stars.map((s) => (
          <circle key={`${s.x}-${s.y}`} className="gs-star" cx={s.x} cy={s.y} r={s.r} style={{ animationDelay: s.d }} />
        ))}
      </g>

      {/* ── warm daylight: welcome glow + driveway (fades at night) ──── */}
      <g className="gs-day">
        <ellipse cx="200" cy="600" rx="150" ry="90" fill="url(#gmGlow)" />
        <path d="M100 650 L300 650 L372 718 L28 718 Z" fill="url(#gmPath)" />
        <path d="M200 654 L200 716" stroke="var(--gold)" strokeWidth="2.5" strokeDasharray="3 12" strokeLinecap="round" opacity="0.4" />
      </g>

      {/* ── ground ──────────────────────────────────────────────────── */}
      <line x1="0" y1="650" x2="400" y2="650" stroke="var(--ink)" strokeOpacity="0.16" strokeWidth="2" />

      {/* ── the gate — glides fully off the LEFT edge to open ──────────
          No clipPath (animating a transform on a clipped group breaks GPU
          compositing → stutter) and no masking rect (a separate element with
          its own colour transition flashes a mismatched strip mid-swap).
          Instead the gate simply slides past x=0; the SVG's own viewport clips
          it — a viewport clip stays composited — so it tucks away cleanly with
          a single smooth glide and nothing to leave behind. */}
      <g className="gs-gate">
        {[...stiles, ...bars.map((x) => ({ x, w: 5 }))].map(({ x, w }) => (
          <g key={x} fill="var(--ink)" opacity="0.85">
            <rect x={x} y="542" width={w} height="106" rx={w / 2} />
            <path d={`M${x - 1.5} 543 L${x + w + 1.5} 543 L${x + w / 2} 528 Z`} />
          </g>
        ))}
        <rect x="96" y="552" width="204" height="10" rx="3" fill="var(--ink)" opacity="0.92" />
        <rect x="96" y="628" width="204" height="10" rx="3" fill="var(--ink)" opacity="0.92" />
        <rect x="96" y="563" width="204" height="2.5" rx="1" fill="var(--terracotta)" opacity="0.55" />
      </g>

      {/* ── gateposts (warm stone), framed with margin ──────────────── */}
      {[{ x: 40 }, { x: 300 }].map(({ x }, i) => (
        <g key={x}>
          <rect x={x} y="520" width="60" height="130" fill="var(--clay)" />
          <rect x={i === 0 ? 92 : 300} y="520" width="8" height="130" fill={i === 0 ? 'var(--paper)' : 'var(--ink)'} opacity={i === 0 ? 0.1 : 0.08} />
          <line x1={x} y1="566" x2={x + 60} y2="566" stroke="var(--ink)" strokeOpacity="0.07" strokeWidth="2" />
          <line x1={x} y1="610" x2={x + 60} y2="610" stroke="var(--ink)" strokeOpacity="0.07" strokeWidth="2" />
          <rect x={x} y="642" width="60" height="8" fill="var(--ink)" opacity="0.12" />
          <rect x={x - 6} y="506" width="72" height="16" rx="3" fill="var(--clay)" />
          <rect x={x - 6} y="506" width="72" height="5" rx="2" fill="var(--ink)" opacity="0.16" />
        </g>
      ))}

      {/* ── post lamp — mounted on the right post, lights at night ──── */}
      <circle className="gs-lamp-glow" cx="314" cy="544" r="34" fill="url(#gmLamp)" />
      <g>
        <rect x="308" y="530" width="12" height="5" rx="2" fill="var(--ink)" opacity="0.6" />
        <path d="M306 556 L322 556 L319 536 L309 536 Z" fill="var(--ink)" opacity="0.55" />
        <path className="gs-lamp-core" d="M309 553 L319 553 L317 539 L311 539 Z" />
      </g>

      {/* ── padlock — appears + clasps once the gate is shut (night) ─── */}
      <g className="gs-lock">
        <path
          className="gs-shackle"
          d="M282 588 L282 577 A10 10 0 0 1 302 577 L302 588"
          fill="none"
          stroke="var(--terracotta)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <rect x="274" y="586" width="36" height="26" rx="5" fill="var(--ink)" />
        <circle cx="292" cy="597" r="3.6" fill="var(--gold-soft)" />
        <rect x="290.4" y="598" width="3.2" height="8" rx="1.6" fill="var(--gold-soft)" />
      </g>
    </svg>
  );
}
