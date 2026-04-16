"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { cn } from "@/lib/utils"

interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Main content of the panel (below the header). */
  children: React.ReactNode
  /**
   * Header content rendered in a 48px-tall row with a subtle bottom border.
   * If omitted, no header is rendered.
   */
  header?: React.ReactNode
  /**
   * Classes applied to the header container. Use to tweak padding/gap.
   */
  headerClassName?: string
  /**
   * Classes applied to the scrollable body container.
   */
  bodyClassName?: string
  /**
   * If true, a drag handle appears on the right edge that lets the user
   * resize the panel's width by click-dragging. Ignored if the panel
   * has `flex-1` (i.e. takes remaining space).
   */
  resizable?: boolean
  /** Initial width in px when `resizable` is true. */
  defaultWidth?: number
  /** Minimum width in px. */
  minWidth?: number
  /** Maximum width in px. */
  maxWidth?: number
  /**
   * Optional localStorage key to persist the resized width across reloads.
   */
  storageKey?: string
}

/**
 * A reusable page-level panel: white rounded card with an optional
 * sticky header row and an optional drag-to-resize right edge.
 *
 * Usage:
 * ```tsx
 * <Panel header={<PanelTitle>Conversations</PanelTitle>} resizable storageKey="inbox:list">
 *   <ConversationList />
 * </Panel>
 * ```
 */
export function Panel({
  children,
  header,
  className,
  headerClassName,
  bodyClassName,
  resizable = false,
  defaultWidth = 320,
  minWidth = 240,
  maxWidth = 640,
  storageKey,
  style,
  ...rest
}: PanelProps) {
  const [width, setWidth] = useState<number | null>(() => {
    if (!resizable) return null
    if (typeof window === "undefined") return defaultWidth
    if (storageKey) {
      const saved = window.localStorage.getItem(storageKey)
      if (saved) {
        const n = parseInt(saved, 10)
        if (!Number.isNaN(n)) {
          return Math.max(minWidth, Math.min(maxWidth, n))
        }
      }
    }
    return defaultWidth
  })
  const [isDragging, setIsDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!resizable) return
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = width ?? defaultWidth
      setIsDragging(true)
    },
    [resizable, width, defaultWidth],
  )

  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const next = Math.max(
        minWidth,
        Math.min(maxWidth, startWidthRef.current + delta),
      )
      setWidth(next)
    }
    const onUp = () => {
      setIsDragging(false)
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    return () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }
  }, [isDragging, minWidth, maxWidth])

  // Persist width on drag end
  useEffect(() => {
    if (isDragging) return
    if (!storageKey || width == null) return
    if (typeof window === "undefined") return
    window.localStorage.setItem(storageKey, String(width))
  }, [isDragging, storageKey, width])

  return (
    <div
      {...rest}
      style={{
        ...style,
        ...(resizable && width != null ? { width, flexShrink: 0 } : null),
      }}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl bg-white",
        // Soft elevation, no ring — feels lighter than ring+shadow combo
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_-2px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {header !== undefined && header !== null && (
        <div
          className={cn(
            "flex h-12 flex-shrink-0 items-center gap-2 border-b border-black/[0.03] px-4",
            headerClassName,
          )}
        >
          {header}
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1 flex-col", bodyClassName)}>
        {children}
      </div>

      {resizable && (
        <button
          type="button"
          aria-label="Resize panel"
          onMouseDown={onHandleMouseDown}
          className={cn(
            "group absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize",
            "before:absolute before:top-1/2 before:right-0 before:h-10 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-transparent before:transition-colors",
            "hover:before:bg-[#F4511E]/40",
            isDragging && "before:!bg-[#F4511E]",
          )}
        />
      )}
    </div>
  )
}

/**
 * Convenience title element for the panel header slot.
 */
export function PanelTitle({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        "truncate text-base font-semibold text-[#2e2e2e]",
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * Convenience actions container for the panel header slot.
 * Pushes its contents to the right side of the header row.
 */
export function PanelActions({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("ml-auto flex items-center gap-1", className)}
    >
      {children}
    </div>
  )
}
