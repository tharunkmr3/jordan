"use client"

// ============================================================================
// <RowActions> and <RowActionButton>
//
// Floating action chip designed to sit in the last (sticky) cell of a
// table row. Hidden by default, fades in on row hover. Visually:
//
//   ┌──────────────┐
//   │ [icon][icon] │   ← white chip, subtle shadow, rounded
//   └──────────────┘
//
// - The CHIP has a white background + soft shadow so it reads as a
//   floating control surface that sits above the row — works whether
//   the row is on white, gray, or a hover tint.
// - Buttons INSIDE the chip stay transparent until hovered, at which
//   point they get a light grey fill. This gives clear affordance per
//   action without any button "looking pressed" at rest.
//
// Usage:
//
//   <tr className="group">
//     ...
//     <td>
//       <RowActions>
//         <RowActionButton label="Duplicate" onClick={dup}><Copy /></RowActionButton>
//         <RowActionButton label="Delete" onClick={del} destructive><Trash /></RowActionButton>
//       </RowActions>
//     </td>
//   </tr>
//
// The PARENT row must have `group` so the chip knows when to fade in
// (`group-hover`).
// ============================================================================

import * as React from "react"
import { cn } from "@/lib/utils"

interface RowActionsProps {
  children: React.ReactNode
  className?: string
}

/**
 * Chip container. Fades in when the closest ancestor with the `group`
 * class is hovered. Rendered inline so it participates in the grid/flex
 * layout of the parent cell.
 */
export function RowActions({ children, className }: RowActionsProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-md bg-white p-0.5",
        // Soft shadow + 1px hairline via box-shadow so no extra DOM
        // ring. Reads as a floating chip on any surface.
        "shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)]",
        "opacity-0 transition-opacity group-hover:opacity-100",
        className
      )}
    >
      {children}
    </div>
  )
}

interface RowActionButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** Accessible label for the button. Also used as the `title` tooltip. */
  label: string
  /** Marks the action as destructive — red tint on hover. */
  destructive?: boolean
  className?: string
}

/**
 * Square 24×24 icon button sized to sit inside <RowActions>. Transparent
 * at rest, light grey fill on hover. If `destructive` is set, the hover
 * fill is red-tinted and the icon turns red — appropriate for delete.
 */
export const RowActionButton = React.forwardRef<HTMLButtonElement, RowActionButtonProps>(
  function RowActionButton({ label, destructive, children, onClick, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        onClick={(e) => {
          // Stop propagation by default — row actions should not trigger
          // whatever the row itself clicks to (e.g. open viewer). Callers
          // that want bubbling can override.
          e.stopPropagation()
          onClick?.(e)
        }}
        className={cn(
          "flex size-6 items-center justify-center rounded text-[#525252] transition-colors",
          destructive
            ? "hover:bg-red-50 hover:text-red-600"
            : "hover:bg-[#f5f5f5] hover:text-[#2e2e2e]",
          className
        )}
        {...rest}
      >
        {children}
      </button>
    )
  }
)
