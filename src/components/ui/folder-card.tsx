"use client"

import { cn } from "@/lib/utils"

interface FolderCardProps {
  id: string
  name: string
  docCount: number
  description?: string | null
  agentName?: string
  lastUpdated?: string
  onClick?: () => void
  className?: string
}

export function FolderCard({ name, docCount, lastUpdated, onClick, className }: FolderCardProps) {
  const dateStr = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null

  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-2xl pt-5 px-3 pb-3 transition-all duration-200 hover:bg-[#f5f5f5] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {/* Inline SVG with animated layers */}
      <svg viewBox="0 0 307 321" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full max-w-[120px] mx-auto h-auto">
        {/* Folder back */}
        <path
          d="M30 1H87.4727C97.1539 1.00012 106.196 5.83144 111.578 13.8789L117.539 22.792C125.148 34.1696 137.933 40.9999 151.62 41H277C293.016 41 306 53.9837 306 70V257C306 273.016 293.016 286 277 286H30C13.9837 286 1 273.016 1 257V30C1 13.9837 13.9837 1 30 1Z"
          fill="#007DEB"
          stroke="url(#paint0_linear_folder)"
          strokeWidth="2"
        />

        {/* Orange file */}
        <rect
          x="37" y="63" width="241" height="210" rx="12"
          fill="#FEBC59"
          className="origin-[37px_63px] transition-transform duration-500 ease-out delay-0 group-hover:rotate-[-8deg] group-hover:translate-x-[-6px] group-hover:translate-y-[-4px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.15))" }}
        />

        {/* White file */}
        <rect
          x="37" y="83" width="241" height="190" rx="12"
          fill="white"
          className="origin-[37px_83px] transition-transform duration-500 ease-out delay-75 group-hover:rotate-[-5deg] group-hover:translate-x-[-3px] group-hover:translate-y-[-2px]"
          style={{ filter: "drop-shadow(0 12px 12px rgba(0,0,0,0.12))" }}
        />

        {/* Folder front */}
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

      {/* Text below folder */}
      <div className="text-center mt-1">
        <h3 className="text-sm font-semibold text-[#0a0a0a] truncate">{name}</h3>
        <p className="text-xs text-[#737373] mt-0.5">
          {docCount} {docCount === 1 ? "Document" : "Documents"}
        </p>
        {dateStr && (
          <p className="text-[11px] text-[#a3a3a3] mt-1">Last added {dateStr}</p>
        )}
      </div>
    </button>
  )
}
