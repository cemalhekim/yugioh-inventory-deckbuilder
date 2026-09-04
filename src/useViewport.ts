import { useLayoutEffect, useState } from 'react'

// The whole app is laid out on a fixed design canvas and scaled to the
// window, so nothing ever needs the page to scroll.
export const designWidth = 1920
export const designHeight = 1080

export function useAppScale() {
  const [scale, setScale] = useState(() => computeScale())

  useLayoutEffect(() => {
    const update = () => setScale(computeScale())
    update()
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  return scale
}

function computeScale() {
  if (typeof window === 'undefined') return 1
  const width = window.visualViewport?.width ?? window.innerWidth
  const height = window.visualViewport?.height ?? window.innerHeight
  return Math.min(width / designWidth, height / designHeight)
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
