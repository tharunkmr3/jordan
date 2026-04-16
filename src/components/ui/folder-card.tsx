"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export const FOLDER_COLORS = [
  { name: "Blue",    main: "#4DA3FF", light: "#A3D1FF", dark: "#2B7DE0", accent: "#FEBC59" },
  { name: "Purple",  main: "#9B8AFE", light: "#C9BFFF", dark: "#7B68E0", accent: "#FFD97A" },
  { name: "Green",   main: "#5CC98E", light: "#A8E6C4", dark: "#3AAF6F", accent: "#FFD97A" },
  { name: "Orange",  main: "#FFA057", light: "#FFCDA3", dark: "#E07A2B", accent: "#FFE8A3" },
  { name: "Pink",    main: "#F478B8", light: "#FFB3D9", dark: "#D45A9A", accent: "#FFD97A" },
  { name: "Cyan",    main: "#4EC5D6", light: "#A3E3EC", dark: "#2AA4B7", accent: "#FEBC59" },
  { name: "Red",     main: "#F06B6B", light: "#FFB3B3", dark: "#D04A4A", accent: "#FFD97A" },
  { name: "Indigo",  main: "#6B8AFF", light: "#A3B8FF", dark: "#4A6BE0", accent: "#FEBC59" },
] as const

export type FolderColor = typeof FOLDER_COLORS[number]

export function getFolderColor(seed: string): FolderColor {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash << 5) - hash + seed.charCodeAt(i)
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length]
}

export function getFolderColorByName(name: string): FolderColor {
  return FOLDER_COLORS.find(c => c.name.toLowerCase() === name.toLowerCase()) || FOLDER_COLORS[0]
}

export interface FolderAction {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  destructive?: boolean
  divider?: boolean
}

interface FolderCardProps {
  id: string
  name: string
  docCount: number
  color?: string
  lastUpdated?: string
  onClick?: () => void
  contextActions?: FolderAction[]
  onRename?: (newName: string) => void
  className?: string
}

export function FolderCard({ id, name, docCount, color, lastUpdated, onClick, contextActions, onRename, className }: FolderCardProps) {
  const c = color ? getFolderColorByName(color) : getFolderColor(id)
  const dateStr = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null

  const gid = `f_${id.slice(0, 8)}`

  const [menuOpen, setMenuOpen] = React.useState(false)
  const [menuPos, setMenuPos] = React.useState({ x: 0, y: 0 })
  const [renaming, setRenaming] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState(name)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menuOpen])

  // Focus input when renaming
  React.useEffect(() => {
    if (renaming) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renaming])

  function handleContextMenu(e: React.MouseEvent) {
    if (!contextActions?.length) return
    e.preventDefault()
    e.stopPropagation()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuOpen(true)
  }

  function handleRenameSubmit() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== name && onRename) {
      onRename(trimmed)
    }
    setRenaming(false)
  }

  function startRename() {
    setRenameValue(name)
    setRenaming(true)
    setMenuOpen(false)
  }

  return (
    <>
    <button
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "group relative w-full text-left rounded-2xl pt-5 px-3 pb-3 transition-all duration-200 hover:bg-[#f5f5f5] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <svg viewBox="0 0 307 321" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full max-w-[120px] mx-auto h-auto">
        {/* Folder back */}
        <path
          d="M30 1H87.4727C97.1539 1.00012 106.196 5.83144 111.578 13.8789L117.539 22.792C125.148 34.1696 137.933 40.9999 151.62 41H277C293.016 41 306 53.9837 306 70V257C306 273.016 293.016 286 277 286H30C13.9837 286 1 273.016 1 257V30C1 13.9837 13.9837 1 30 1Z"
          fill={c.main}
          stroke={`url(#${gid}_s)`}
          strokeWidth="2"
        />
        {/* Orange/accent file */}
        <rect
          x="37" y="63" width="241" height="210" rx="12"
          fill={c.accent}
          className="origin-[37px_63px] transition-transform duration-500 ease-out delay-0 group-hover:rotate-[-8deg] group-hover:translate-x-[-6px] group-hover:translate-y-[-4px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.12))" }}
        />
        {/* White file */}
        <rect
          x="37" y="83" width="241" height="190" rx="12"
          fill="white"
          className="origin-[37px_83px] transition-transform duration-500 ease-out delay-75 group-hover:rotate-[-5deg] group-hover:translate-x-[-3px] group-hover:translate-y-[-2px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.08))" }}
        />
        {/* Folder front */}
        <rect
          x="1" y="103" width="305" height="183" rx="29"
          fill={`url(#${gid}_f)`}
          fillOpacity="0.85"
          stroke={`url(#${gid}_fs)`}
          strokeWidth="2"
        />
        <defs>
          <linearGradient id={`${gid}_s`} x1="12.5" y1="7" x2="287.5" y2="279.5" gradientUnits="userSpaceOnUse">
            <stop stopColor={c.light} />
            <stop offset="1" stopColor={c.dark} />
          </linearGradient>
          <linearGradient id={`${gid}_f`} x1="153.5" y1="102" x2="153.5" y2="287" gradientUnits="userSpaceOnUse">
            <stop stopColor={c.light} />
            <stop offset="1" stopColor={c.dark} />
          </linearGradient>
          <linearGradient id={`${gid}_fs`} x1="7" y1="138" x2="316" y2="221" gradientUnits="userSpaceOnUse">
            <stop stopColor={c.light} />
            <stop offset="1" stopColor={c.dark} />
          </linearGradient>
        </defs>
      </svg>

      <div className="text-center mt-1">
        {renaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={e => { if (e.key === "Enter") handleRenameSubmit(); if (e.key === "Escape") setRenaming(false) }}
            onClick={e => e.stopPropagation()}
            className="text-sm font-semibold text-[#1f1f1f] text-center w-full bg-transparent border-b border-[#1f1f1f]/20 outline-none focus:border-[#1f1f1f]/50 px-1"
          />
        ) : (
          <h3 className="text-sm font-semibold text-[#1f1f1f] truncate" onDoubleClick={(e) => { e.stopPropagation(); if (onRename) startRename() }}>{name}</h3>
        )}
        <p className="text-xs text-[#737373] mt-0.5">
          {docCount} {docCount === 1 ? "Document" : "Documents"}
        </p>
        {dateStr && (
          <p className="text-[11px] text-[#a3a3a3] mt-1">Last added {dateStr}</p>
        )}
      </div>
    </button>

    {/* Context menu */}
    {menuOpen && contextActions && (
      <div
        ref={menuRef}
        className="fixed z-50 min-w-[180px] rounded-lg border border-black/[0.06] bg-white shadow-lg py-1 animate-in fade-in-0 zoom-in-95"
        style={{ left: menuPos.x, top: menuPos.y }}
      >
        {contextActions.map((action, i) => (
          <React.Fragment key={i}>
            {action.divider && <div className="my-1 border-t border-black/[0.06]" />}
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (action.label === "Rename" && onRename) { startRename() }
                else { action.onClick() }
                setMenuOpen(false)
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors",
                action.destructive ? "text-red-600 hover:bg-red-50" : "text-[#1f1f1f] hover:bg-[#f5f5f5]"
              )}
            >
              {action.icon}
              {action.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    )}
    </>
  )
}

// Color picker component for use in create/edit dialogs
export function FolderColorPicker({ value, onChange }: { value?: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FOLDER_COLORS.map(c => (
        <button
          key={c.name}
          type="button"
          onClick={() => onChange(c.name)}
          className={cn(
            "h-7 w-7 rounded-full transition-all",
            value === c.name ? "ring-2 ring-offset-2 ring-[#1f1f1f] scale-110" : "hover:scale-110"
          )}
          style={{ background: c.main }}
          title={c.name}
        />
      ))}
    </div>
  )
}
