import { useState, useEffect } from 'react'

export function useBreakpoint() {
  const getW = () => (typeof window !== 'undefined' ? window.innerWidth : 1280)
  const [width, setWidth] = useState(getW)

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth)
    window.addEventListener('resize', handler, { passive: true })
    return () => window.removeEventListener('resize', handler)
  }, [])

  return {
    width,
    isMobile:      width < 768,
    isTablet:      width >= 768 && width < 1024,
    isDesktop:     width >= 1024,
    isSmallMobile: width < 480,
  }
}
