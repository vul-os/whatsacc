import { useEffect, useState } from 'react';

// Resolved avatar URL: prefer the CDN-cached version (phase 2) and fall back
// to the raw origin URL (phase 1). Exported so callers don't reimplement the
// precedence rule.
export function resolveAvatarUrl(
  source: { avatar_url: string | null; avatar_cdn_url: string | null } | null | undefined,
): string | null {
  if (!source) return null;
  return source.avatar_cdn_url || source.avatar_url || null;
}

function initialsFor(name: string | null | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '';
  return (first + last).toUpperCase() || '·';
}

const sizeMap = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-12 w-12 text-sm',
  xl: 'h-20 w-20 text-base',
} as const;
export type AvatarSize = keyof typeof sizeMap;

export type AvatarProps = {
  url?: string | null;
  /** convenience: pass the auth user / profile and we pull avatar_cdn_url ?? avatar_url */
  source?: { avatar_url: string | null; avatar_cdn_url: string | null } | null;
  name: string | null | undefined;
  size?: AvatarSize;
  /** tailwind tone class for the initials box; defaults to ink/paper */
  toneClass?: string;
  className?: string;
};

export function Avatar({
  url,
  source,
  name,
  size = 'sm',
  toneClass = 'bg-ink text-paper',
  className = '',
}: AvatarProps) {
  const resolved = url !== undefined ? url : resolveAvatarUrl(source);
  // broken-image fallback: if the <img> errors we drop to initials. Keyed by
  // the URL so a new url retries.
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [resolved]);

  const sizeClasses = sizeMap[size];
  const initials = initialsFor(name);

  return (
    <span
      className={`relative inline-grid place-items-center rounded-full overflow-hidden font-medium ${sizeClasses} ${toneClass} ${className}`}
      aria-hidden
    >
      {resolved && !broken ? (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setBroken(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span className="leading-none">{initials}</span>
      )}
    </span>
  );
}
