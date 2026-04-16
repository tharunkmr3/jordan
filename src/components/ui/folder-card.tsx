"use client"

import { cn } from "@/lib/utils"

interface FolderCardProps {
  id: string
  name: string
  docCount: number
  description?: string | null
  agentName?: string
  onClick?: () => void
  className?: string
}

export function FolderCard({ name, docCount, description, agentName, onClick, className }: FolderCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-2xl transition-all duration-300 hover:-translate-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {/* Default folder */}
      <img
        src="/Folder_default.svg"
        alt=""
        className="w-full h-auto block transition-opacity duration-200 group-hover:opacity-0"
        draggable={false}
      />
      {/* Hovered folder */}
      <img
        src="/Folder_hovered.svg"
        alt=""
        className="w-full h-auto absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        draggable={false}
      />

      {/* Info overlay on the folder front */}
      <div className="absolute bottom-[35%] left-0 right-0 px-5 pointer-events-none">
        <h3 className="text-sm font-semibold text-white truncate drop-shadow-sm">{name}</h3>
        <p className="text-xs text-white/70 mt-0.5 drop-shadow-sm">
          {docCount} {docCount === 1 ? "document" : "documents"}
        </p>
      </div>

      {/* Info below */}
      <div className="px-1 pt-2 pb-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0a0a0a] truncate flex-1">{name}</h3>
          {agentName && (
            <span className="text-[11px] text-[#a3a3a3] shrink-0">{agentName}</span>
          )}
        </div>
        {description && <p className="text-xs text-[#737373] mt-0.5 truncate">{description}</p>}
      </div>
    </button>
  )
}
