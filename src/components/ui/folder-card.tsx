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
      {/* Inline SVG with animated layers */}
      <svg viewBox="0 0 307 321" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-auto">
        {/* Folder back */}
        <path
          d="M30 1H87.4727C97.1539 1.00012 106.196 5.83144 111.578 13.8789L117.539 22.792C125.148 34.1696 137.933 40.9999 151.62 41H277C293.016 41 306 53.9837 306 70V257C306 273.016 293.016 286 277 286H30C13.9837 286 1 273.016 1 257V30C1 13.9837 13.9837 1 30 1Z"
          fill="#007DEB"
          stroke="url(#paint0_linear_folder)"
          strokeWidth="2"
        />

        {/* Orange file — animates on hover with delay */}
        <rect
          x="37" y="63" width="241" height="210" rx="12"
          fill="#FEBC59"
          className="origin-[37px_63px] transition-transform duration-500 ease-out delay-0 group-hover:rotate-[-8deg] group-hover:translate-x-[-6px] group-hover:translate-y-[-4px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.15))" }}
        />

        {/* White file — animates on hover with slight delay */}
        <rect
          x="37" y="83" width="241" height="190" rx="12"
          fill="white"
          className="origin-[37px_83px] transition-transform duration-500 ease-out delay-75 group-hover:rotate-[-5deg] group-hover:translate-x-[-3px] group-hover:translate-y-[-2px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.12))" }}
        />

        {/* Folder front (glass overlay) */}
        <rect
          x="1" y="103" width="305" height="183" rx="29"
          fill="url(#paint1_linear_folder)"
          fillOpacity="0.8"
          stroke="url(#paint2_linear_folder)"
          strokeWidth="2"
        />

        <defs>
          <linearGradient id="paint0_linear_folder" x1="12.5" y1="7" x2="287.5" y2="279.5" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5FB4FF" />
            <stop offset="1" stopColor="#006ECF" />
          </linearGradient>
          <linearGradient id="paint1_linear_folder" x1="153.5" y1="102" x2="153.5" y2="287" gradientUnits="userSpaceOnUse">
            <stop stopColor="#4CABFF" />
            <stop offset="1" stopColor="#004785" />
          </linearGradient>
          <linearGradient id="paint2_linear_folder" x1="7" y1="138.529" x2="316.582" y2="221.004" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5FB4FF" />
            <stop offset="1" stopColor="#006ECF" />
          </linearGradient>
        </defs>
      </svg>

      {/* Name + count overlaid on folder front */}
      <div className="absolute bottom-[32%] left-0 right-0 px-5 pointer-events-none">
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
