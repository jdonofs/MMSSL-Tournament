import { useEffect, useState } from 'react'

export default function useIsCompactViewport(threshold = 900) {
  const [isCompact, setIsCompact] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= threshold : false
  ))

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const onResize = () => setIsCompact(window.innerWidth <= threshold)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [threshold])

  return isCompact
}
