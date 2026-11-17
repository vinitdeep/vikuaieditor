import { useId } from 'react'

/**
 * Viku mark: a gold V that is also a downward play triangle, inside a graphite tile with two
 * viewfinder corners (the 9:16 reel frame). Same drawing as build/icon.svg; below 28 px the corners drop out.
 */
export function Logo({ size = 22, tile = true }: { size?: number; tile?: boolean }) {
  const id = useId().replace(/:/g, '')
  const small = size < 28
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="vk-logo">
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2B2D33" />
          <stop offset="1" stopColor="#16171A" />
        </linearGradient>
        <linearGradient id={`${id}gd`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE48A" />
          <stop offset="1" stopColor="#FFD24A" />
        </linearGradient>
      </defs>
      {tile && (
        <>
          <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${id}bg)`} />
          <rect x="2.5" y="2.5" width="59" height="59" rx="14.5" fill="none" stroke="#fff" strokeOpacity="0.09" />
        </>
      )}
      {small ? (
        <path
          fill="#FFD24A"
          fillRule="evenodd"
          d="M15.6 13h32.8c3 0 4.8 3.1 3.4 5.7L35.4 49.5c-1.5 2.8-5.3 2.8-6.8 0L12.2 18.7c-1.4-2.6.4-5.7 3.4-5.7Zm9 0 6.1 13.4c.5 1.1 2.1 1.1 2.6 0L39.4 13Z"
        />
      ) : (
        <>
          <path d="M20.5 11.5h-4a5 5 0 0 0-5 5v4M43.5 52.5h4a5 5 0 0 0 5-5v-4" fill="none" stroke="#FFD24A" strokeOpacity="0.5" strokeWidth="2.6" strokeLinecap="round" />
          <path
            fill={`url(#${id}gd)`}
            fillRule="evenodd"
            d="M19.6 17h24.8c2.6 0 4.2 2.7 3 5L35 46.6c-1.3 2.5-4.7 2.5-6 0L16.6 22c-1.2-2.3.4-5 3-5Zm6.9 0 4.3 9.8c.5 1.1 1.9 1.1 2.4 0L37.5 17Z"
          />
        </>
      )}
    </svg>
  )
}
