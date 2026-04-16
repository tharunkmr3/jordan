"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

export const HEADER_SLOT_ID = "page-header-actions"

/**
 * Portals its children into the app layout's header (right side), so
 * any page can add filters, action buttons, or other controls there
 * without lifting state or touching the layout itself.
 *
 * Usage:
 * ```tsx
 * export default function DashboardPage() {
 *   return (
 *     <>
 *       <HeaderActions>
 *         <Select .../>
 *       </HeaderActions>
 *       <div>...page body...</div>
 *     </>
 *   )
 * }
 * ```
 *
 * Requires `<div id={HEADER_SLOT_ID} />` to exist in the layout header.
 */
export function HeaderActions({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setEl(document.getElementById(HEADER_SLOT_ID))
  }, [])

  if (!el) return null
  return createPortal(children, el)
}
