"use client"

// ============================================================================
// PDF Renderer — custom pdf.js view for the KB file viewer
//
// Replaces the browser-native <iframe> view for PDFs (and PPT/PPTX files that
// are converted to PDF server-side by LibreOffice). Built on react-pdf so we
// get full control over chrome: our own toolbar, thumbnails sidebar, zoom,
// and page navigation — matching Jordon's styling instead of Chrome's dark
// toolbar.
//
// Worker note: pdfjs-dist ships its worker as an ES module
// (pdf.worker.min.mjs). We copy it to /public at repo level and point
// GlobalWorkerOptions.workerSrc at /pdf.worker.min.mjs. This avoids bundler
// URL mangling and keeps the worker cacheable by the browser like any other
// static asset.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/TextLayer.css"
import "react-pdf/dist/Page/AnnotationLayer.css"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Download,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from "lucide-react"

// Point pdfjs at the worker we copied into /public. Version query param
// forces a cache bust when pdfjs-dist (bundled under react-pdf) upgrades
// — otherwise the browser may serve an old worker whose API version
// doesn't match, producing "worker version does not match" errors.
// The postinstall hook in package.json keeps /public/pdf.worker.min.mjs
// in sync with react-pdf's nested pdfjs-dist on `npm install`.
if (typeof window !== "undefined") {
  pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`
}

interface Props {
  /** Signed URL to the PDF (or converted PPTX PDF). */
  url: string
  /** Filename for the download button. */
  filename: string
}

// Zoom tier table — discrete stops feel much nicer than freeform ±10%.
const ZOOM_STEPS: number[] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]

export function PdfRenderer({ url, filename }: Props) {
  const [numPages, setNumPages] = useState<number | null>(null)
  const [scale, setScale] = useState(1.0)
  const [fitToWidth, setFitToWidth] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  // Page rail is always visible — removed the toggle since the rail is
  // a slim 24px column and provides useful context even on short docs.
  const [containerWidth, setContainerWidth] = useState<number>(800)
  const [error, setError] = useState<string | null>(null)

  const pagesContainerRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Observe container width so fit-to-width stays responsive when the
  // viewer panel is resized. Uses layout-effect timing via ResizeObserver.
  useEffect(() => {
    const el = pagesContainerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Subtract horizontal padding (24px * 2) and a hairline of safety
        const w = entry.contentRect.width
        setContainerWidth(Math.max(320, Math.floor(w - 48)))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Track which page is currently in view. The previous IntersectionObserver
  // approach with sparse thresholds [0.25, 0.5, 0.75] missed updates between
  // boundaries — if page N stayed at 40% visibility while scrolling, no
  // event fired and the rail indicator got stuck.
  //
  // Fix: keep a live map of every page's intersection ratio updated by the
  // observer (with many closely-spaced thresholds), then on each callback
  // pick the page with the highest current ratio. The rail always tracks
  // whichever page is most visible.
  //
  // Re-attaching is keyed on numPages AND a tick counter bumped after the
  // DOM has the page refs — pageRefs.current mutates during reconciliation
  // and the first effect run may see an empty map.
  const [pagesMountedTick, setPagesMountedTick] = useState(0)
  useEffect(() => {
    if (numPages) {
      // Schedule a tick after the page rows have been painted so the
      // observer attaches to the real page DOM nodes, not to nothing.
      const raf = requestAnimationFrame(() => setPagesMountedTick((t) => t + 1))
      return () => cancelAnimationFrame(raf)
    }
  }, [numPages])

  useEffect(() => {
    const root = pagesContainerRef.current
    if (!root || !numPages) return

    // Live ratio map — gets overwritten as the observer fires. We don't
    // clear this between callbacks; a page that scrolls out still has
    // ratio=0 recorded so the "max ratio" scan still works.
    const ratios = new Map<number, number>()

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number(
            (entry.target as HTMLElement).dataset.page ?? 0
          )
          if (pageNum) ratios.set(pageNum, entry.intersectionRatio)
        }
        // Pick the page with the highest visibility. Break ties by
        // smallest page number so the rail doesn't jitter between
        // equally-visible siblings on rapid scroll.
        let bestPage = 0
        let bestRatio = 0
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio || (ratio === bestRatio && ratio > 0 && page < bestPage)) {
            bestRatio = ratio
            bestPage = page
          }
        }
        if (bestPage > 0) {
          setCurrentPage((prev) => (prev === bestPage ? prev : bestPage))
        }
      },
      {
        root,
        // Dense thresholds — fires every 5% of visibility change so the
        // ratio map stays accurate during smooth scroll, and we catch
        // transitions even for pages taller than the viewport that
        // never reach 50% visibility.
        threshold: Array.from({ length: 21 }, (_, i) => i / 20),
      }
    )

    pageRefs.current.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [numPages, pagesMountedTick])

  const onLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
    setError(null)
  }, [])

  const onLoadError = useCallback((err: Error) => {
    console.error("[pdf-renderer] load failed:", err)
    setError(err.message ?? "Could not open PDF")
  }, [])

  // --- Navigation / zoom ---------------------------------------------------

  const goToPage = useCallback((n: number) => {
    const el = pageRefs.current.get(n)
    if (el && pagesContainerRef.current) {
      // Use scrollIntoView within the viewer scroll root rather than the
      // whole page — prevents jumping to the top of the document.
      pagesContainerRef.current.scrollTo({
        top: el.offsetTop - 8,
        behavior: "smooth",
      })
    }
  }, [])

  const zoomIn = () => {
    setFitToWidth(false)
    setScale((s) => {
      const idx = ZOOM_STEPS.findIndex((v) => v > s)
      return idx === -1 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[idx]
    })
  }

  const zoomOut = () => {
    setFitToWidth(false)
    setScale((s) => {
      // Find the largest step less than current
      let pick = ZOOM_STEPS[0]
      for (const v of ZOOM_STEPS) {
        if (v < s) pick = v
      }
      return pick
    })
  }

  const fitWidth = () => {
    setFitToWidth(true)
    setScale(1.0)
  }

  // Width actually passed to <Page>: either follows container (fit) or is a
  // fixed pixel value derived from the scale multiplier.
  const pageWidth = fitToWidth ? containerWidth : Math.round(800 * scale)

  const fileOptions = useMemo(
    () => ({ url }),
    [url]
  )

  // --- Render --------------------------------------------------------------

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 bg-[#fafafa]">
        <div className="max-w-sm text-center">
          <AlertCircle size={24} className="mx-auto text-red-600 mb-3" />
          <div className="text-sm font-medium text-[#2e2e2e]">
            Could not open PDF
          </div>
          <p className="text-xs text-[#737373] mt-1.5">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#fafafa]">
      {/* Toolbar — matches Jordon's 44px panel-sub-header style */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 border-b border-black/[0.04] bg-white">
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </Button>
          <div className="text-[12px] tabular-nums text-[#525252] px-1.5 min-w-[60px] text-center">
            {numPages ? `${currentPage} / ${numPages}` : "—"}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() =>
              goToPage(Math.min(numPages ?? 1, currentPage + 1))
            }
            disabled={!numPages || currentPage >= numPages}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </Button>
        </div>

        <div className="mx-1 h-5 w-px bg-black/[0.06]" />

        <div className="flex items-center gap-0.5">
          <Button size="icon-sm" variant="ghost" onClick={zoomOut} aria-label="Zoom out">
            <ZoomOut size={14} />
          </Button>
          <div className="text-[12px] tabular-nums text-[#525252] px-1.5 min-w-[42px] text-center">
            {fitToWidth ? "Fit" : `${Math.round(scale * 100)}%`}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={zoomIn} aria-label="Zoom in">
            <ZoomIn size={14} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={fitWidth}
            aria-label="Fit to width"
            title="Fit to width"
          >
            <Maximize2 size={14} />
          </Button>
        </div>

        <div className="ml-auto">
          <a
            href={url}
            download={filename}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] font-medium text-[#525252] hover:bg-[#f5f5f5] hover:text-[#2e2e2e] transition-colors"
            title="Download original"
          >
            <Download size={13} />
            Download
          </a>
        </div>
      </div>

      {/* Body: page rail + pages column. Use a single <Document> wrapping
          both so react-pdf loads once and the rail's hover-preview reuses
          the same document handle. */}
      <Document
        file={fileOptions}
        onLoadSuccess={onLoadSuccess}
        onLoadError={onLoadError}
        loading={
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 overflow-auto px-6 py-4">
              <div className="mx-auto max-w-[800px] space-y-3">
                <Skeleton className="aspect-[8.5/11] w-full rounded-lg" />
              </div>
            </div>
          </div>
        }
        error={null}
        className="flex-1 min-h-0 flex overflow-hidden"
      >
        {numPages && (
          <PageRail
            numPages={numPages}
            currentPage={currentPage}
            onSelect={goToPage}
          />
        )}

        <div
          ref={pagesContainerRef}
          className="flex-1 min-w-0 overflow-auto px-6 py-4"
        >
          <div className="mx-auto flex flex-col items-center gap-4 w-full">
            {numPages &&
              Array.from({ length: numPages }).map((_, i) => {
                const pageNum = i + 1
                  return (
                    <div
                      key={pageNum}
                      data-page={pageNum}
                      ref={(el) => {
                        if (el) pageRefs.current.set(pageNum, el)
                        else pageRefs.current.delete(pageNum)
                      }}
                      // White page shadow matches how Preview / Acrobat render
                      // pages — reads as actual pages, not canvas rectangles
                      className="bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_-2px_rgba(0,0,0,0.06)] rounded-sm"
                      style={{ width: pageWidth }}
                    >
                      <Page
                        pageNumber={pageNum}
                        width={pageWidth}
                        loading={
                          <Skeleton
                            className="rounded-sm"
                            style={{
                              width: pageWidth,
                              height: pageWidth * (11 / 8.5),
                            }}
                          />
                        }
                      />
                    </div>
                  )
                })}
          </div>
        </div>
      </Document>
    </div>
  )
}

// ============================================================================
// PageRail — minimal line-style page navigator
//
// Shows one short horizontal line per page, stacked vertically in a narrow
// column. Active page gets a longer bold line. On hover over any line, a
// real page thumbnail appears next to it (via react-pdf's <Page>, sharing
// the outer <Document>). Click to jump to that page.
//
// Why this exists:
//   - The classic full-thumbnails sidebar eats 144px of horizontal space
//     and forces pdfjs to render every page upfront — expensive for big
//     PDFs.
//   - This rail is ~28px wide, renders zero thumbnails until the user
//     hovers, and still gives a strong visual sense of "I'm on page 3 of
//     38" via the bold line position.
// ============================================================================

function PageRail({
  numPages,
  currentPage,
  onSelect,
}: {
  numPages: number
  currentPage: number
  onSelect: (page: number) => void
}) {
  // Which page is being hovered — drives the popover preview. null means
  // nothing is hovered, so no preview renders (saves pdfjs work).
  const [hoverPage, setHoverPage] = useState<number | null>(null)
  const [hoverTop, setHoverTop] = useState(0)

  // Ensure the active-page line stays visible when the user scrolls
  // through a long document. Without this, on a 300-page PDF you'd lose
  // the indicator below the rail's scroll fold.
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [currentPage])

  // Hover handler — measure the position of the hovered button relative
  // to the rail so the thumbnail preview appears next to the line being
  // hovered (regardless of whether the rail is scrolled or the lines are
  // vertically centered in a short document).
  const handleEnter = (pageNum: number, e: React.MouseEvent<HTMLButtonElement>) => {
    setHoverPage(pageNum)
    const btnRect = e.currentTarget.getBoundingClientRect()
    const railRect = railRef.current?.getBoundingClientRect()
    if (railRect) {
      setHoverTop(btnRect.top - railRect.top + btnRect.height / 2)
    }
  }

  return (
    <div ref={railRef} className="relative w-6 shrink-0">
      {/* Inner column centers the page lines vertically. justify-center
          means short PDFs (2-3 pages) sit in the middle of the viewer
          height instead of clinging to the top; long PDFs overflow
          naturally with scroll. items-start left-aligns every line so
          the "longer when active" and "grow on hover" both extend from
          a common left anchor. */}
      <div className="h-full overflow-y-auto flex flex-col items-start justify-center py-2 pl-2">
        {Array.from({ length: numPages }).map((_, i) => {
          const pageNum = i + 1
          const isActive = pageNum === currentPage
          return (
            <button
              key={pageNum}
              ref={isActive ? activeRef : undefined}
              onClick={() => onSelect(pageNum)}
              onMouseEnter={(e) => handleEnter(pageNum, e)}
              onMouseLeave={() =>
                setHoverPage((p) => (p === pageNum ? null : p))
              }
              aria-label={`Go to page ${pageNum}`}
              title={`Page ${pageNum}`}
              className="group relative flex h-2 w-full items-center justify-start"
            >
              {/* All lines same weight (1px tall). Active and hover
                  states animate the WIDTH only — not the thickness —
                  so the rail reads as a clean timeline where position
                  is the only thing that changes, not line heft. */}
              <span
                className={`block h-px rounded-full transition-[width,background-color] duration-200 ease-out ${
                  isActive
                    ? "w-4 bg-[#2e2e2e] group-hover:w-5"
                    : "w-2.5 bg-[#a3a3a3] group-hover:w-4 group-hover:bg-[#525252]"
                }`}
              />
            </button>
          )
        })}
      </div>

      {/* Hover preview — position centered vertically on the hovered line
          so the thumbnail's middle aligns with the line. */}
      {hoverPage !== null && (
        <RailHoverPreview pageNum={hoverPage} centerY={hoverTop} />
      )}
    </div>
  )
}

function RailHoverPreview({
  pageNum,
  centerY,
}: {
  pageNum: number
  /** Y-coordinate (in the rail's coordinate space) of the hovered line. */
  centerY: number
}) {
  const thumbWidth = 160
  const thumbHeight = thumbWidth * (11 / 8.5)
  // Offset so the thumbnail's vertical middle is aligned with the line.
  const top = centerY - thumbHeight / 2
  return (
    <div
      className="pointer-events-none absolute left-full z-30 ml-1"
      style={{ top: Math.max(8, top) }}
    >
      <div className="rounded-md bg-white shadow-[0_4px_20px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.05)] p-1.5">
        <Page
          pageNumber={pageNum}
          width={thumbWidth}
          renderTextLayer={false}
          renderAnnotationLayer={false}
          loading={
            <Skeleton className="rounded" style={{ width: thumbWidth, height: thumbHeight }} />
          }
        />
        <div className="mt-1 text-center text-[10px] font-medium text-[#737373] tabular-nums">
          Page {pageNum}
        </div>
      </div>
    </div>
  )
}
