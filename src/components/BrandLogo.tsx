import React from 'react';

export const BRAND_NAME = 'Canastica';
export const BRAND_TAGLINE = 'Lo que falta, antes de que falte';

interface BrandMarkProps {
  /** Tailwind size + radius classes for the tile, e.g. "w-9 h-9 rounded-xl". */
  className?: string;
}

/** Canastica logo on a white tile, so it reads the same on light, dark and green backgrounds. */
export const BrandMark: React.FC<BrandMarkProps> = ({ className = 'w-9 h-9 rounded-xl' }) => (
  <span
    className={`${className} shrink-0 bg-white ring-1 ring-black/5 shadow-sm flex items-center justify-center overflow-hidden`}
  >
    <img
      src="/brand/canastica-logo.png"
      alt={BRAND_NAME}
      className="w-[78%] h-[78%] object-contain"
      draggable={false}
    />
  </span>
);
