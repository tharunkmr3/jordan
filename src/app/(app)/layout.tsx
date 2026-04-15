"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  SquaresFour,
  Robot,
  ChatCircleDots,
  UsersThree,
  BookOpenText,
  ChartBar,
  Broadcast,
  CreditCard,
  GearSix,
  MagnifyingGlass,
  Bell,
  CaretDown,
  SidebarSimple,
  SignOut,
  Plus,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { createBrowserClient } from "@supabase/ssr"

const nav = [
  { label: "Dashboard", href: "/dashboard", icon: SquaresFour },
  { label: "Inbox", href: "/inbox", icon: ChatCircleDots },
  { label: "Contacts", href: "/contacts", icon: UsersThree },
  { label: "Knowledge", href: "/knowledge", icon: BookOpenText },
  { label: "Analytics", href: "/analytics", icon: ChartBar },
  { label: "Channels", href: "/channels", icon: Broadcast },
]

interface SidebarAgent { id: string; name: string; status: string; avatar_url?: string | null }

const bottomNav = [
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "Settings", href: "/settings", icon: GearSix },
]

function JordonLogo() {
  return (
    <svg width="22" height="24" viewBox="0 0 30 34" fill="none">
      <path
        d="M13.4352 0.0177586C18.7894 -0.00801237 24.1436 -0.00573525 29.4977 0.0245945C29.5506 10.2795 30.7276 20.1341 22.5553 27.882C16.2625 33.848 10.6984 33.8766 2.58067 33.717C2.45856 29.4152 2.55535 24.5842 2.55039 20.2424C4.91134 20.2126 7.31537 20.2382 9.68028 20.2424L9.70078 27.1047C15.4825 25.4291 19.2874 22.8085 21.5172 16.9875C22.9124 13.3454 22.7719 10.6081 22.7545 6.7951L13.4078 6.77362L13.4352 0.0177586ZM0.0181674 6.75213C4.44548 6.72359 8.87328 6.72359 13.3004 6.75213L13.2877 13.8937L0.0767611 13.884C-0.048528 11.6958 0.0169779 8.98811 0.0181674 6.75213Z"
        fill="currentColor"
      />
    </svg>
  )
}

function NavItem({ item, isActive, collapsed }: { item: typeof nav[0]; isActive: boolean; collapsed: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-[500] transition-colors",
        collapsed && "justify-center px-0",
        isActive
          ? "bg-[#ebebeb] text-[#0a0a0a]"
          : "text-[#0a0a0a] hover:bg-[#ebebeb]"
      )}
    >
      <Icon size={18} weight={isActive ? "fill" : "regular"} className={isActive ? "text-[#0a0a0a]" : "text-[#737373]"} />
      {!collapsed && item.label}
    </Link>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)

  // Listen for toggle events from child pages (e.g., inbox)
  useEffect(() => {
    const handler = () => setCollapsed((c) => !c)
    window.addEventListener("toggle-sidebar", handler)
    return () => window.removeEventListener("toggle-sidebar", handler)
  }, [])
  const [userName, setUserName] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [agents, setAgents] = useState<SidebarAgent[]>([])

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    async function loadUser() {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setUserName(user.user_metadata?.full_name || user.email?.split("@")[0] || "User")
        setUserEmail(user.email || "")
      }
    }
    loadUser()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load agents for sidebar section
  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch("/api/agents")
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data)) setAgents(data.map((a: SidebarAgent) => ({ id: a.id, name: a.name, status: a.status, avatar_url: a.avatar_url })))
        }
      } catch { /* ignore */ }
    }
    loadAgents()
    // Refetch when a page signals it needs a fresh list
    const refreshHandler = () => loadAgents()
    window.addEventListener("refresh-agents", refreshHandler)

    // Optimistic updates: merge partial updates into the current list
    const updateHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; name?: string; status?: string; avatar_url?: string | null }>).detail
      if (!detail?.id) return
      setAgents(prev => prev.map(a => a.id === detail.id ? { ...a, ...detail } : a))
    }
    window.addEventListener("agent-updated", updateHandler)

    return () => {
      window.removeEventListener("refresh-agents", refreshHandler)
      window.removeEventListener("agent-updated", updateHandler)
    }
  }, [pathname])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push("/login")
    router.refresh()
  }

  // Derive page title from pathname
  const pageTitle = nav.find(n => pathname === n.href || pathname.startsWith(n.href + "/"))?.label
    || bottomNav.find(n => pathname === n.href || pathname.startsWith(n.href + "/"))?.label
    || "Dashboard"

  return (
    <div className="flex h-screen bg-[#f5f5f5]">
      {/* Sidebar */}
      <aside className={cn(
        "flex flex-col bg-[#f5f5f5] transition-all duration-200",
        collapsed ? "w-[60px]" : "w-[220px]"
      )}>
        {/* Logo */}
        <div className={cn("flex h-12 items-center gap-2.5 px-4", collapsed && "justify-center px-0")}>
          <JordonLogo />
          {!collapsed && (
            <span className="text-[15px] font-semibold tracking-tight text-[#0a0a0a]">
              Jordon
            </span>
          )}
        </div>

        {/* New Agent */}
        {!collapsed ? (
          <div className="px-3 pt-2">
            <Link
              href="/agents/new"
              className="flex items-center justify-center gap-1.5 rounded-md bg-[#0a0a0a] hover:bg-[#262626] text-white px-3 py-2 text-[13px] font-medium transition-colors"
            >
              <Plus size={14} weight="bold" />
              New Agent
            </Link>
          </div>
        ) : (
          <div className="flex justify-center pt-2">
            <Link href="/agents/new" className="rounded-md bg-[#0a0a0a] hover:bg-[#262626] text-white p-2" title="New Agent">
              <Plus size={16} weight="bold" />
            </Link>
          </div>
        )}

        {/* Search */}
        {!collapsed && (
          <div className="px-3 pt-3">
            <div className="flex items-center gap-2 rounded-md border border-[#e0e0e0] bg-white px-2.5 py-1.5">
              <MagnifyingGlass size={15} weight="regular" className="text-[#a3a3a3] flex-shrink-0" />
              <input
                type="text"
                placeholder="Search..."
                className="w-full bg-transparent text-[13px] text-[#0a0a0a] placeholder-[#a3a3a3] outline-none"
              />
            </div>
          </div>
        )}
        {collapsed && (
          <div className="flex justify-center pt-3">
            <button className="rounded-md p-1.5 text-[#737373] hover:bg-[#ebebeb]">
              <MagnifyingGlass size={18} weight="regular" />
            </button>
          </div>
        )}

        {/* Main nav */}
        <nav className="flex-1 overflow-y-auto space-y-0.5 px-2 pt-3">
          {nav.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              isActive={pathname === item.href || pathname.startsWith(item.href + "/")}
              collapsed={collapsed}
            />
          ))}

          {/* Agents section */}
          {!collapsed && agents.length > 0 && (
            <div className="pt-4">
              <div className="flex items-center justify-between px-3 mb-1">
                <span className="text-[10px] font-semibold text-[#a3a3a3] uppercase tracking-wider">Agents</span>
                <span className="text-[10px] text-[#a3a3a3]">{agents.length}</span>
              </div>
              <div className="space-y-0.5">
                {agents.map((a) => {
                  const isActive = pathname === `/agents/${a.id}`
                  return (
                    <Link
                      key={a.id}
                      href={`/agents/${a.id}`}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-[500] transition-colors",
                        isActive ? "bg-[#ebebeb] text-[#0a0a0a]" : "text-[#525252] hover:bg-[#ebebeb]"
                      )}
                    >
                      {a.avatar_url ? (
                        <img src={a.avatar_url} alt={a.name} className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="h-5 w-5 rounded-full bg-[#0a0a0a] text-white text-[9px] font-semibold flex items-center justify-center flex-shrink-0">
                          {a.name[0]?.toUpperCase() || 'A'}
                        </div>
                      )}
                      <span className="truncate flex-1">{a.name}</span>
                      {a.status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />}
                    </Link>
                  )
                })}
              </div>
            </div>
          )}
        </nav>

        {/* Bottom nav */}
        <div className="space-y-0.5 border-t border-[#ebebeb] px-2 py-2">
          {bottomNav.map((item) => (
            <NavItem
              key={item.href}
              item={item}
              isActive={pathname === item.href || pathname.startsWith(item.href + "/")}
              collapsed={collapsed}
            />
          ))}
        </div>

        {/* User */}
        <div className="relative border-t border-[#ebebeb] px-2 py-2">
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={cn(
                "flex flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] hover:bg-[#ebebeb]",
                collapsed && "justify-center px-0 flex-none"
              )}
            >
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#0a0a0a] text-[11px] font-medium text-white">
                {userName ? userName.charAt(0).toUpperCase() : "U"}
              </div>
              {!collapsed && (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[13px] font-[500] text-[#0a0a0a]">{userName || "Loading..."}</div>
                  </div>
                  <CaretDown size={12} weight="bold" className="text-[#a3a3a3]" />
                </>
              )}
            </button>
            <button className="relative rounded-md p-2 text-[#737373] hover:bg-[#ebebeb] hover:text-[#0a0a0a] flex-shrink-0" title="Notifications">
              <Bell size={16} weight="regular" />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#0a0a0a]" />
            </button>
          </div>
          {showUserMenu && (
            <div className={cn(
              "absolute bottom-full mb-1 rounded-lg border border-[#e0e0e0] bg-white p-1 shadow-lg",
              collapsed ? "left-1 w-48" : "left-2 right-2"
            )}>
              <div className="px-3 py-2 border-b border-[#ebebeb]">
                <div className="truncate text-[13px] font-[500] text-[#0a0a0a]">{userName}</div>
                <div className="truncate text-[12px] text-[#737373]">{userEmail}</div>
              </div>
              <button
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-red-600 hover:bg-red-50"
              >
                <SignOut size={16} weight="regular" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main area */}
      {pathname === "/inbox" ? (
        /* Inbox owns its own layout — no outer header/card */
        <div className="flex flex-1 flex-col overflow-hidden bg-[#f5f5f5]">
          <main className="flex-1 overflow-hidden">{children}</main>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden bg-[#f5f5f5] p-3">
          <div className="flex h-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-[#ebebeb]">
            {/* Header (inside card) */}
            <header className="flex h-12 items-center justify-between border-b border-[#ebebeb] px-5 flex-shrink-0">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#0a0a0a]"
                >
                  <SidebarSimple size={18} weight="duotone" />
                </button>
                <span className="text-[15px] font-semibold text-[#0a0a0a]">{pageTitle}</span>
              </div>
              <div />

            </header>

            {/* Page content */}
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </div>
      )}
    </div>
  )
}
