import { cn } from '@/lib/utils';

/** Logotipo DELTA X local (SVG, sin raster; ESP §17.4) + marca "KATALYST". */
export function BrandLogo({ variant = 'sidebar', className }: { variant?: 'sidebar' | 'login'; className?: string }) {
  const w = variant === 'login' ? 190 : 142;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <svg width={w} viewBox="0 0 142 36" role="img" aria-label="DeltaX" className="h-auto">
        <defs>
          <linearGradient id="kx-silver" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f2f2f4" />
            <stop offset="0.55" stopColor="#b9bac2" />
            <stop offset="1" stopColor="#7c7d86" />
          </linearGradient>
        </defs>
        <text
          x="0"
          y="31"
          fill="#ED9405"
          fontFamily="'Inter Variable', Inter, system-ui, sans-serif"
          fontWeight="900"
          fontSize="33"
          letterSpacing="-0.5"
          transform="scale(0.9 1)"
        >
          DELTA
        </text>
        <path d="M104 9 L130 33" stroke="url(#kx-silver)" strokeWidth="7" strokeLinecap="round" />
        <path d="M100 34 C 112 24, 124 12, 141 4 C 130 14, 120 22, 110 34 Z" fill="#ED9405" />
      </svg>
      <span className="font-mono text-[10px] font-medium tracking-[0.25em] text-[#83848c]">KATALYST</span>
    </div>
  );
}
