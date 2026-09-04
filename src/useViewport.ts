import { useLayoutEffect, useState } from 'react'

// The app is laid out on a canvas that matches the window's own resolution
// (native text size on 1920x1080 and larger) and is only scaled down when the
// window is smaller than the minimum layout, so nothing ever needs the page
// to scroll and nothing grows past native size on big monitors.
export const minLayoutWidth = 1920
export const minLayoutHeight = 1080

export type Viewport = { scale: number; width: number; height: number }

export function useAppScale(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => computeViewport())

  useLayoutEffect(() => {
    const update = () => setViewport(computeViewport())
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  return viewport
}

function computeViewport(): Viewport {
  if (typeof window === 'undefined') {
    return { scale: 1, width: minLayoutWidth, height: minLayoutHeight }
  }
  const width = window.visualViewport?.width ?? window.innerWidth
  const height = window.visualViewport?.height ?? window.innerHeight
  const scale = Math.min(1, width / minLayoutWidth, height / minLayoutHeight)
  return { scale, width: Math.round(width / scale), height: Math.round(height / scale) }
}

// Hard-block page scrolling: overflow is hidden in CSS, this catches the
// cases CSS cannot (focus-driven scrolls, anchors, keyboard on body).
export function useScrollLock() {
  useLayoutEffect(() => {
    const reset = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
    }
    const blockKeys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (editable) return
      if (target && target !== document.body && target.closest('[data-scroll]')) return
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        event.preventDefault()
      }
    }
    window.addEventListener('scroll', reset)
    window.addEventListener('keydown', blockKeys)
    return () => {
      window.removeEventListener('scroll', reset)
      window.removeEventListener('keydown', blockKeys)
    }
  }, [])
}
