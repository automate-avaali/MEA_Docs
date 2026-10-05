import { useId } from "react";

type Variant = "dusk" | "day" | "night";

const PALETTE: Record<Variant, { top: string; mid: string; low: string; glowA: string; glowB: string; cloud: string; cloudWarm: string; shade: string }> = {
  // Gulf dusk: deep cobalt-teal sky, saffron & apricot clouds
  dusk: { top: "#24479e", mid: "#4f78c9", low: "#a7bfe6", glowA: "#f4b26f", glowB: "#d3a6d6", cloud: "#fff4e6", cloudWarm: "#f2b277", shade: "#8b93cf" },
  // Pale airy morning, sand-warm clouds
  day: { top: "#a7c3ea", mid: "#d0e0f4", low: "#f1f4f8", glowA: "#ffffff", glowB: "#f9e6d4", cloud: "#ffffff", cloudWarm: "#fbe8d4", shade: "#c3d2ea" },
  // Desert night: indigo sky, moon glow, dim lilac clouds, a last ember of sunset on the horizon
  night: { top: "#050816", mid: "#111a3f", low: "#2a2c5a", glowA: "#b9673f", glowB: "#8ea2ff", cloud: "#3b4475", cloudWarm: "#6a4d72", shade: "#161b3d" },
};

type Puff = { x: number; y: number; rx: number; ry: number; warm?: boolean };

const CLOUDS: Puff[][] = [
  // lower-left bank
  [
    { x: 120, y: 760, rx: 260, ry: 90, warm: true },
    { x: 330, y: 700, rx: 200, ry: 110, warm: true },
    { x: 80, y: 640, rx: 160, ry: 70 },
    { x: 520, y: 790, rx: 240, ry: 80 },
  ],
  // upper-right streaks
  [
    { x: 1250, y: 210, rx: 230, ry: 60, warm: true },
    { x: 1420, y: 300, rx: 260, ry: 85, warm: true },
    { x: 1330, y: 380, rx: 180, ry: 55 },
    { x: 1500, y: 150, rx: 140, ry: 40 },
  ],
  // wispy upper-left
  [
    { x: 260, y: 170, rx: 240, ry: 38 },
    { x: 430, y: 240, rx: 200, ry: 30 },
  ],
  // lower-right
  [
    { x: 1300, y: 760, rx: 260, ry: 90 },
    { x: 1480, y: 680, rx: 200, ry: 100, warm: true },
  ],
];

// Deterministic star field (no randomness at render → no hydration mismatch): [x, y, radius, twinkle delay].
const STARS: [number, number, number, number][] = Array.from({ length: 70 }, (_, i) => {
  const a = (i * 9301 + 49297) % 233280;
  const b = (i * 4721 + 12345) % 233280;
  return [(a / 233280) * 1600, (b / 233280) * 520, i % 9 === 0 ? 1.8 : i % 3 === 0 ? 1.2 : 0.8, (i % 7) * 0.6];
});

/** Painted-sky backdrop drawn with SVG turbulence — no image assets needed. */
export function Sky({ variant = "dusk", className = "" }: { variant?: Variant; className?: string }) {
  const id = useId().replace(/:/g, "");
  const p = PALETTE[variant];
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={`sky${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={p.top} />
            <stop offset="0.55" stopColor={p.mid} />
            <stop offset="1" stopColor={p.low} />
          </linearGradient>
          <radialGradient id={`gA${id}`} cx="0.15" cy="0.9" r="0.55">
            <stop offset="0" stopColor={p.glowA} stopOpacity="0.85" />
            <stop offset="1" stopColor={p.glowA} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`gB${id}`} cx="0.88" cy="0.25" r="0.45">
            <stop offset="0" stopColor={p.glowB} stopOpacity="0.7" />
            <stop offset="1" stopColor={p.glowB} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`c${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={p.cloud} />
            <stop offset="1" stopColor={p.shade} stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id={`cw${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={p.cloud} />
            <stop offset="0.55" stopColor={p.cloudWarm} />
            <stop offset="1" stopColor={p.shade} />
          </linearGradient>
          <filter id={`paint${id}`} x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves="4" seed="7" />
            <feDisplacementMap in="SourceGraphic" scale="90" />
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <filter id={`grain${id}`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.06 0" />
          </filter>
        </defs>
        <rect width="1600" height="900" fill={`url(#sky${id})`} />
        <rect width="1600" height="900" fill={`url(#gA${id})`} />
        <rect width="1600" height="900" fill={`url(#gB${id})`} />
        <g className="animate-drift" filter={`url(#paint${id})`}>
          {CLOUDS.map((group, gi) => (
            <g key={gi} opacity={gi === 2 ? 0.55 : 0.92}>
              {group.map((c, i) => (
                <ellipse key={i} cx={c.x} cy={c.y} rx={c.rx} ry={c.ry} fill={c.warm ? `url(#cw${id})` : `url(#c${id})`} />
              ))}
            </g>
          ))}
        </g>
        {variant === "night" && (
          <g>
            {STARS.map(([x, y, r, d], i) => (
              <circle key={i} cx={x} cy={y} r={r} fill="#fff" className="animate-twinkle" style={{ animationDelay: `${d}s` }} />
            ))}
            {/* True crescent: the lit disc minus an offset disc (mask), so the sky shows through the dark side. */}
            <defs>
              <mask id={`moon${id}`}>
                <rect width="1600" height="900" fill="#000" />
                <circle cx="1310" cy="150" r="40" fill="#fff" />
                <circle cx="1329" cy="139" r="37" fill="#000" />
              </mask>
              <radialGradient id={`moonGlow${id}`}>
                <stop offset="0" stopColor="#e9e6ff" stopOpacity="0.35" />
                <stop offset="1" stopColor="#e9e6ff" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="1302" cy="154" r="120" fill={`url(#moonGlow${id})`} />
            <circle cx="1310" cy="150" r="40" fill="#f4f1ff" mask={`url(#moon${id})`} />
          </g>
        )}
        <rect width="1600" height="900" filter={`url(#grain${id})`} />
      </svg>
    </div>
  );
}

/** Day (or dusk) art in light mode, night art in dark mode — switched by CSS, so it follows the toggle instantly. */
export function ThemedSky({ day = "dusk" }: { day?: Exclude<Variant, "night"> }) {
  return (
    <>
      <div className="sky-day">
        <Sky variant={day} />
      </div>
      <div className="sky-night">
        <Sky variant="night" />
      </div>
    </>
  );
}
