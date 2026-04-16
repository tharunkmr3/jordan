"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

export const HEADER_SLOT_ID = "page-header-actions"

// ---------------------------------------------------------------------------
// Header title override (context-based so the layout can conditionally
// swap its default pageTitle string for a custom node like a back button +
// entity name when a page enters a detail view).
// ---------------------------------------------------------------------------

interface HeaderTitleContextValue {
  node: ReactNode | null
  setNode: (n: ReactNode | null) => void
}

const HeaderTitleContext = createContext<HeaderTitleContextValue | null>(null)

export function PageHeaderTitleProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode | null>(null)
  const value = useMemo(() => ({ node, setNode }), [node])
  return (
    <HeaderTitleContext.Provider value={value}>
      {children}
    </HeaderTitleContext.Provider>
  )
}

/**
 * Read the current custom header title. Layout uses this to decide
 * whether to render its default pageTitle or a page-supplied node.
 */
export function usePageHeaderTitle(): ReactNode | null {
  return useContext(HeaderTitleContext)?.node ?? null
}

/**
 * Override the page header title with custom content.
 *
 * ```tsx
 * <HeaderTitle>
 *   <button onClick={...}><ArrowLeft /></button>
 *   <span>{folder.name}</span>
 * </HeaderTitle>
 * ```
 *
 * The custom title stays in effect until this component unmounts.
 * Wrap its children in useMemo if they're expensive or if you're seeing
 * re-render churn — otherwise the context update is cheap.
 */
export function HeaderTitle({ children }: { children: ReactNode }) {
  const ctx = useContext(HeaderTitleContext)
  useEffect(() => {
    if (!ctx) return
    ctx.setNode(children)
    return () => ctx.setNode(null)
  }, [children, ctx])
  return null
}

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
