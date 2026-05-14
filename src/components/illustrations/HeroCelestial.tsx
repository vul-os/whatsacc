import type { SVGProps } from 'react';

const rays = Array.from({ length: 12 }, (_, i) => (i * 360) / 12);

export function HeroCelestial({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 480 600"
      className={`hero-celestial ${className ?? ''}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="A sun in daylight, a moon at night"
      {...rest}
    >
      <defs>
        {/* sun — gold disc with warm core */}
        <radialGradient id="hcSunDisc" cx="42%" cy="40%" r="64%">
          <stop offset="0%" stopColor="#F0DCA0" />
          <stop offset="55%" stopColor="#C8A45C" />
          <stop offset="100%" stopColor="#9A7A38" />
        </radialGradient>

        {/* sun halo — soft gold bloom that spills into the page */}
        <radialGradient id="hcSunHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#DEC07A" stopOpacity="0.55" />
          <stop offset="35%" stopColor="#C8A45C" stopOpacity="0.22" />
          <stop offset="70%" stopColor="#C2A88C" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#C2A88C" stopOpacity="0" />
        </radialGradient>

        {/* moon — pearly disc, lit from upper-left */}
        <radialGradient id="hcMoonDisc" cx="36%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#F5EFE6" />
          <stop offset="55%" stopColor="#D4C39A" />
          <stop offset="100%" stopColor="#7A6440" />
        </radialGradient>

        {/* moon halo — soft cream glow */}
        <radialGradient id="hcMoonHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#D4AE6A" stopOpacity="0.34" />
          <stop offset="55%" stopColor="#D4AE6A" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#D4AE6A" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* sun — visible in light */}
      <g className="hc-sun">
        <circle cx="270" cy="240" r="220" fill="url(#hcSunHalo)" />
        <g className="hc-sun-rays" stroke="#B8914A" strokeWidth="1.25" strokeLinecap="round">
          {rays.map((deg) => (
            <line
              key={deg}
              x1="270"
              y1="158"
              x2="270"
              y2="140"
              transform={`rotate(${deg} 270 240)`}
            />
          ))}
        </g>
        <circle cx="270" cy="240" r="62" fill="url(#hcSunDisc)" />
        <circle cx="270" cy="240" r="62" fill="none" stroke="#9A7A38" strokeWidth="0.8" opacity="0.35" />
        <circle cx="252" cy="222" r="14" fill="#F0E0B5" opacity="0.45" />
      </g>

      {/* moon — visible in dark */}
      <g className="hc-moon">
        <circle cx="282" cy="232" r="200" fill="url(#hcMoonHalo)" />
        <circle cx="282" cy="232" r="62" fill="url(#hcMoonDisc)" />
        {/* craters — subtle, asymmetric */}
        <ellipse cx="262" cy="216" rx="11" ry="9" fill="#7A6440" opacity="0.30" />
        <ellipse cx="300" cy="246" rx="8" ry="7" fill="#7A6440" opacity="0.26" />
        <ellipse cx="275" cy="258" rx="5.5" ry="5" fill="#7A6440" opacity="0.22" />
        <ellipse cx="294" cy="210" rx="4" ry="3.5" fill="#7A6440" opacity="0.28" />
        <ellipse cx="252" cy="246" rx="3.5" ry="3" fill="#7A6440" opacity="0.22" />
        <circle cx="282" cy="232" r="62" fill="none" stroke="#7A6440" strokeWidth="0.8" opacity="0.30" />
      </g>
    </svg>
  );
}
