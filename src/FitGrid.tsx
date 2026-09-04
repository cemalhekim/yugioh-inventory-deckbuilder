import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

type FitGridProps = {
  count: number
  gap: number
  /** Never use fewer columns than this, so few items stay small instead of ballooning. */
  minColumns?: number
  className?: string
  children: ReactNode
} & (
  | { mode: 'cards'; itemAspect: number }
  | { mode: 'rows'; rowHeight: number; minColumnWidth: number }
)

// A grid that picks its column count so that `count` items fill the
// available box without overflowing: cards keep their aspect ratio and
// shrink, rows wrap into more columns.
export function FitGrid(props: FitGridProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const { count, gap, className, children } = props
  const minColumns = props.minColumns ?? 1
  const aspect = props.mode === 'cards' ? props.itemAspect : 0
  const rowHeight = props.mode === 'rows' ? props.rowHeight : 0
  const minColumnWidth = props.mode === 'rows' ? props.minColumnWidth : 0

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (width: number, height: number) => {
      setColumns(
        Math.max(
          minColumns,
          aspect
            ? fitCards(width, height, count, aspect, gap)
            : fitRows(width, height, count, rowHeight, minColumnWidth, gap),
        ),
      )
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) measure(box.width, box.height)
    })
    observer.observe(element)
    measure(element.clientWidth, element.clientHeight)
    return () => observer.disconnect()
  }, [count, aspect, rowHeight, minColumnWidth, gap, minColumns])

  return (
    <div
      ref={ref}
      className={className}
      style={{ '--fit-cols': columns } as CSSProperties}
    >
      {children}
    </div>
  )
}

function fitCards(width: number, height: number, count: number, aspect: number, gap: number) {
  if (count <= 0 || width <= 0 || height <= 0) return 1
  for (let columns = 1; columns <= count; columns += 1) {
    const cardWidth = (width - gap * (columns - 1)) / columns
    const cardHeight = cardWidth / aspect
    const rows = Math.ceil(count / columns)
    if (rows * cardHeight + gap * (rows - 1) <= height) return columns
  }
  return count
}

function fitRows(
  width: number,
  height: number,
  count: number,
  rowHeight: number,
  minColumnWidth: number,
  gap: number,
) {
  if (count <= 0 || width <= 0 || height <= 0) return 1
  let columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
  const rowsFit = Math.max(1, Math.floor((height + gap) / (rowHeight + gap)))
  while (Math.ceil(count / columns) > rowsFit) {
    const next = columns + 1
    if ((width - gap * (next - 1)) / next < 120) break
    columns = next
  }
  return columns
}
