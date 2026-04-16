"use client"

import { cn } from "@/lib/utils"

const FOLDER_COLORS = [
  { bg: "from-violet-400 to-violet-500", tab: "bg-violet-500", files: ["bg-violet-200", "bg-violet-100", "bg-white"] },
  { bg: "from-blue-400 to-blue-500", tab: "bg-blue-500", files: ["bg-blue-200", "bg-blue-100", "bg-white"] },
  { bg: "from-emerald-400 to-emerald-500", tab: "bg-emerald-500", files: ["bg-emerald-200", "bg-emerald-100", "bg-white"] },
  { bg: "from-amber-400 to-amber-500", tab: "bg-amber-500", files: ["bg-amber-200", "bg-amber-100", "bg-white"] },
  { bg: "from-rose-400 to-rose-500", tab: "bg-rose-500", files: ["bg-rose-200", "bg-rose-100", "bg-white"] },
  { bg: "from-cyan-400 to-cyan-500", tab: "bg-cyan-500", files: ["bg-cyan-200", "bg-cyan-100", "bg-white"] },
  { bg: "from-orange-400 to-orange-500", tab: "bg-orange-500", files: ["bg-orange-200", "bg-orange-100", "bg-white"] },
  { bg: "from-pink-400 to-pink-500", tab: "bg-pink-500", files: ["bg-pink-200", "bg-pink-100", "bg-white"] },
]

function getColor(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash << 5) - hash + seed.charCodeAt(i)
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length]
}

interface FolderCardProps {
  id: string
  name: string
  docCount: number
  description?: string | null
  agentName?: string
  onClick?: () => void
  className?: string
}

export function FolderCard({ id, name, docCount, description, agentName, onClick, className }: FolderCardProps) {
  const color = getColor(id)

  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-2xl p-0 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {/* Folder body */}
      <div className={cn("relative rounded-2xl bg-gradient-to-b overflow-hidden", color.bg)} style={{ aspectRatio: "4/3" }}>
        {/* Tab */}
        <div className="absolute top-0 left-0">
          <div className={cn("h-6 w-20 rounded-br-xl rounded-tl-2xl", color.tab)} />
        </div>

        {/* Files — stacked papers that fan out on hover */}
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-3">
          {/* File 3 (back) */}
          <div
            className={cn(
              "absolute bottom-3 left-3 right-3 h-[60%] rounded-lg shadow-sm transition-all duration-300 ease-out",
              color.files[0],
              "group-hover:-translate-y-3 group-hover:-rotate-1"
            )}
          />
          {/* File 2 (middle) */}
          <div
            className={cn(
              "absolute bottom-3 left-3 right-3 h-[60%] rounded-lg shadow-sm transition-all duration-300 ease-out delay-[50ms]",
              color.files[1],
              "group-hover:-translate-y-1.5 group-hover:rotate-[0.5deg]"
            )}
          />
          {/* File 1 (front — white) */}
          <div
            className={cn(
              "relative h-[60%] rounded-lg shadow-sm transition-all duration-300 ease-out delay-100",
              color.files[2],
              "group-hover:translate-y-0.5"
            )}
          >
            {/* File lines */}
            <div className="p-3 space-y-1.5 opacity-40">
              <div className="h-1.5 w-3/4 rounded-full bg-black/10" />
              <div className="h-1.5 w-1/2 rounded-full bg-black/10" />
              <div className="h-1.5 w-2/3 rounded-full bg-black/10" />
            </div>
          </div>
        </div>

        {/* Hover glow */}
        <div className="absolute inset-0 rounded-2xl bg-white/0 transition-colors duration-300 group-hover:bg-white/5" />
      </div>

      {/* Info below */}
      <div className="px-1 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0a0a0a] truncate flex-1">{name}</h3>
          {agentName && (
            <span className="text-[11px] text-[#a3a3a3] shrink-0">{agentName}</span>
          )}
        </div>
        <p className="text-xs text-[#737373] mt-0.5">
          {docCount} {docCount === 1 ? "document" : "documents"}
          {description && ` · ${description}`}
        </p>
      </div>
    </button>
  )
}
