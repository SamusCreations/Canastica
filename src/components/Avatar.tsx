import React, { useState } from 'react';

interface AvatarProps {
  name?: string;
  src?: string;
  color?: string;
  className?: string;
}

function initialsOf(name = ''): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Member avatar with an initials fallback when the photo is missing or fails to load. */
export const Avatar: React.FC<AvatarProps> = ({
  name,
  src,
  color = '#4f7f27',
  className = 'w-7 h-7',
}) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;

  if (showImage) {
    return (
      <img
        src={src}
        alt={name || ''}
        onError={() => setFailedSrc(src ?? null)}
        className={`${className} rounded-full object-cover shrink-0 bg-slate-200 dark:bg-slate-700`}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={name || ''}
      title={name}
      className={`${className} rounded-full shrink-0 inline-flex items-center justify-center font-bold text-white select-none text-[0.7em] leading-none`}
      style={{ backgroundColor: color }}
    >
      <span className="text-[10px]">{initialsOf(name)}</span>
    </span>
  );
};
