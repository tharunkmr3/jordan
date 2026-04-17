"use client"

// ============================================================================
// <Source> / <SourceTrigger> / <SourceContent>
//
// Source citation chip — small link with a hover-card showing the title
// and description. Used under assistant messages in the chat UI to cite
// KB documents that the agent consulted. Click the chip to navigate to
// the source (in our case, deep-links into the KB viewer).
//
// API mirrors prompt-kit's Source so the calling code stays idiomatic:
//
//   <Source href="/knowledge?kb=…&doc=…">
//     <SourceTrigger showFavicon />
//     <SourceContent title="Report.xlsx" description="…snippet…" />
//   </Source>
//
// Visual: compact pill with optional favicon/icon and filename. Opens a
// Popover on hover/focus (desktop) or tap (mobile) with richer detail.
// Clicking anywhere on the chip follows the href in a new tab.
// ============================================================================

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Context: share href + icon slot between Trigger and Content
// ---------------------------------------------------------------------------

interface SourceCtx {
  href: string
  icon?: React.ReactNode
  /** How trigger + content connect — content auto-shows on trigger hover. */
  id: string
}
const SourceContext = React.createContext<SourceCtx | null>(null)
function useSource(): SourceCtx {
  const ctx = React.useContext(SourceContext)
  if (!ctx) throw new Error('<Source*> must be used inside <Source>')
  return ctx
}

// ---------------------------------------------------------------------------
// <Source>
// ---------------------------------------------------------------------------

interface SourceProps {
  /** URL to navigate to when the chip is clicked (opens in new tab). */
  href: string
  /** Optional leading icon element (e.g. a DocumentTypeIcon). Overrides
      favicon if both are provided on the trigger. */
  icon?: React.ReactNode
  children: React.ReactNode
}

export function Source({ href, icon, children }: SourceProps) {
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const ctx = React.useMemo(() => ({ href, icon, id }), [href, icon, id])

  return (
    <SourceContext.Provider value={ctx}>
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        {/* Expose hover handlers via a wrapper so both the trigger and
            the popup can keep it open while the user moves between them. */}
        <div
          className="inline-block"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {children}
        </div>
      </PopoverPrimitive.Root>
    </SourceContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// <SourceTrigger>
// ---------------------------------------------------------------------------

interface SourceTriggerProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** If true, fetch the favicon of the href's domain and render a 12px
      image. External-web use case. For internal KB sources, prefer
      passing an `icon` prop to <Source>. */
  showFavicon?: boolean
  /** Label inside the chip (falls back to the href's host). */
  label?: string
}

export function SourceTrigger({
  showFavicon,
  label,
  className,
  children,
  ...rest
}: SourceTriggerProps) {
  const { href, icon } = useSource()
  const displayLabel = label ?? safeHost(href)
  const faviconUrl = showFavicon ? faviconFor(href) : null

  return (
    <PopoverPrimitive.Trigger
      // We're rendering an <a> (so clicks navigate to the doc in a new
      // tab). base-ui's Trigger defaults to `nativeButton={true}`,
      // which warns if the render target isn't a <button>. Opt out
      // explicitly — we don't want button semantics on a link.
      nativeButton={false}
      render={
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1.5 max-w-[220px] h-6 px-2 rounded-full",
            "bg-white text-[12px] text-[#525252] font-medium",
            "ring-1 ring-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
            "hover:ring-black/[0.12] hover:text-[#2e2e2e] hover:bg-[#fafafa]",
            "transition-colors cursor-pointer",
            className,
          )}
          {...rest}
        >
          {icon ? (
            <span className="shrink-0 flex items-center">{icon}</span>
          ) : faviconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={faviconUrl}
              alt=""
              className="h-3 w-3 shrink-0 rounded-sm"
              onError={(e) => {
                // Fall back to a neutral dot on favicon 404.
                ;(e.currentTarget as HTMLImageElement).style.display = "none"
              }}
            />
          ) : null}
          <span className="truncate">{children ?? displayLabel}</span>
        </a>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// <SourceContent>
// ---------------------------------------------------------------------------

interface SourceContentProps {
  title: string
  description?: string
  /** Optional extra body — any ReactNode (e.g. custom metadata). */
  children?: React.ReactNode
  className?: string
}

export function SourceContent({
  title,
  description,
  children,
  className,
}: SourceContentProps) {
  const { href } = useSource()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side="top" sideOffset={6} align="start">
        <PopoverPrimitive.Popup
          className={cn(
            "z-50 w-[300px] rounded-lg bg-white p-3",
            "ring-1 ring-black/[0.06] shadow-[0_6px_20px_-4px_rgba(0,0,0,0.12),0_2px_6px_-2px_rgba(0,0,0,0.08)]",
            "text-[12px] text-[#525252]",
            "origin-[var(--transform-origin)] transition-[opacity,transform] duration-100",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]",
            className,
          )}
        >
          <div className="text-[13px] font-semibold text-[#2e2e2e] leading-snug truncate">
            {title}
          </div>
          <div className="mt-0.5 text-[11px] text-[#a3a3a3] truncate">
            {safeHost(href) || href}
          </div>
          {description && (
            <p className="mt-2 text-[12px] leading-relaxed text-[#525252] line-clamp-4">
              {description}
            </p>
          )}
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeHost(href: string): string {
  try {
    const url = new URL(href, typeof window !== 'undefined' ? window.location.origin : 'http://x')
    return url.host || url.pathname
  } catch {
    return href
  }
}

function faviconFor(href: string): string | null {
  try {
    const host = new URL(href).host
    if (!host) return null
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`
  } catch {
    return null
  }
}
