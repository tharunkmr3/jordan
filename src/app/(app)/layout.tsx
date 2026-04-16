"use client"

import { useState, useEffect, Suspense } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  House,
  Robot,
  ChatCircleDots,
  UsersThree,
  BookOpenText,
  ChartBar,
  CreditCard,
  GearSix,
  MagnifyingGlass,
  Bell,
  CaretDown,
  SidebarSimple,
  SignOut,
  PlusCircle,
  DotsThreeVertical,
  IconContext,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { createBrowserClient } from "@supabase/ssr"
import { PageHeaderTitleProvider, usePageHeaderTitle } from "@/components/ui/header-actions"
import { ContactAvatar } from "@/components/ui/contact-avatar"

const navGroup1 = [
  { label: "Home", href: "/dashboard", icon: House },
]
const navGroup2 = [
  { label: "All conversations", href: "/inbox", icon: ChatCircleDots },
  { label: "Contacts", href: "/contacts", icon: UsersThree },
  { label: "Knowledge", href: "/knowledge", icon: BookOpenText },
  { label: "Analytics", href: "/analytics", icon: ChartBar },
]
const nav = [...navGroup1, ...navGroup2]

interface SidebarAgent { id: string; name: string; status: string; avatar_url?: string | null; settings?: { is_customer_facing?: boolean } }

const bottomNav = [
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "Settings", href: "/settings", icon: GearSix },
]

function JordonLogo() {
  return (
    <svg width="16" height="18" viewBox="0 0 30 34" fill="none">
      <path
        d="M13.4352 0.0177586C18.7894 -0.00801237 24.1436 -0.00573525 29.4977 0.0245945C29.5506 10.2795 30.7276 20.1341 22.5553 27.882C16.2625 33.848 10.6984 33.8766 2.58067 33.717C2.45856 29.4152 2.55535 24.5842 2.55039 20.2424C4.91134 20.2126 7.31537 20.2382 9.68028 20.2424L9.70078 27.1047C15.4825 25.4291 19.2874 22.8085 21.5172 16.9875C22.9124 13.3454 22.7719 10.6081 22.7545 6.7951L13.4078 6.77362L13.4352 0.0177586ZM0.0181674 6.75213C4.44548 6.72359 8.87328 6.72359 13.3004 6.75213L13.2877 13.8937L0.0767611 13.884C-0.048528 11.6958 0.0169779 8.98811 0.0181674 6.75213Z"
        fill="currentColor"
      />
    </svg>
  )
}

function HeaderTitleArea({ defaultTitle }: { defaultTitle: string }) {
  const custom = usePageHeaderTitle()
  if (custom) return <div className="flex min-w-0 items-center gap-2">{custom}</div>
  return <span className="text-base font-semibold text-[#2e2e2e]">{defaultTitle}</span>
}

function NavItem({ item, isActive, collapsed }: { item: typeof nav[0]; isActive: boolean; collapsed: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] leading-none font-medium transition-colors",
        collapsed && "justify-center px-0",
        isActive
          ? "bg-white text-[#2e2e2e] shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.04)]"
          : "text-[#525252] hover:bg-[#ebebeb] hover:text-[#2e2e2e]"
      )}
    >
      <Icon size={16} weight="bold" className={isActive ? "text-[#525252]" : "text-[#737373]"} />
      {!collapsed && item.label}
    </Link>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // useSearchParams() inside AppLayoutInner forces a client-side
  // render bail-out during static prerender. Wrap in Suspense so
  // Next can handle the boundary cleanly at build time.
  return (
    <Suspense fallback={null}>
      <AppLayoutInner>{children}</AppLayoutInner>
    </Suspense>
  )
}

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const currentAgentId = pathname === "/inbox" ? searchParams.get("agentId") : null
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
  const [agentMenuOpen, setAgentMenuOpen] = useState<string | null>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!agentMenuOpen) return
    const close = () => setAgentMenuOpen(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [agentMenuOpen])

  async function deleteAgent(id: string) {
    if (!confirm("Delete this agent? This cannot be undone.")) return
    setAgents(prev => prev.filter(a => a.id !== id))
    setAgentMenuOpen(null)
    await fetch(`/api/agents/${id}`, { method: "DELETE" })
    if (pathname.startsWith(`/agents/${id}`) || pathname === "/inbox") {
      router.push("/dashboard")
    }
  }

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
          if (Array.isArray(data)) setAgents(data.map((a: SidebarAgent) => ({ id: a.id, name: a.name, status: a.status, avatar_url: a.avatar_url, settings: a.settings })))
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
  const pageTitle = [...nav, ...bottomNav].find(n => pathname === n.href || pathname.startsWith(n.href + "/"))?.label
    || (pathname.startsWith("/agents/") ? "Agent" : undefined)
    || bottomNav.find(n => pathname === n.href || pathname.startsWith(n.href + "/"))?.label
    || "Dashboard"

  return (
    <IconContext.Provider value={{ weight: "bold" }}>
    <PageHeaderTitleProvider>
    <div className="flex h-screen bg-[#f5f5f5]">
      {/* Sidebar */}
      <aside className={cn(
        "group/sidebar flex flex-col bg-[#f5f5f5] pt-3 transition-all duration-200",
        collapsed ? "w-[60px]" : "w-[220px]"
      )}>
        {/* Logo */}
        <div className={cn("flex h-12 items-center px-5", collapsed ? "justify-center px-0" : "gap-3")}>
          {collapsed ? (
            <button
              onClick={() => setCollapsed(false)}
              className="relative flex h-8 w-8 items-center justify-center rounded-md hover:bg-[#ebebeb] transition-colors"
              title="Expand sidebar"
            >
              <span className="transition-opacity group-hover/sidebar:opacity-0">
                <JordonLogo />
              </span>
              <SidebarSimple size={16} weight="duotone" className="absolute text-[#737373] opacity-0 group-hover/sidebar:opacity-100 transition-opacity" />
            </button>
          ) : (
            <>
              <JordonLogo />
              <span className="text-base font-bold tracking-tight text-[#2e2e2e] flex-1">
                Jordon
              </span>
              <button
                onClick={() => setCollapsed(true)}
                className="rounded-md p-1 text-[#737373] hover:bg-[#ebebeb] hover:text-[#2e2e2e]"
                title="Collapse sidebar"
              >
                <SidebarSimple size={16} weight="duotone" />
              </button>
            </>
          )}
        </div>

        {/* Main nav */}
        <nav className="flex-1 overflow-y-auto px-2 pt-3">
          {/* Group 1: Home + Search */}
          <div className="space-y-0.5">
            {navGroup1.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
              return <NavItem key={item.href} item={item} isActive={isActive} collapsed={collapsed} />
            })}
            <button
              type="button"
              title={collapsed ? "Search" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-[13px] leading-none font-medium text-[#525252] hover:bg-[#ebebeb] hover:text-[#2e2e2e] transition-colors",
                collapsed && "justify-center px-0"
              )}
            >
              <MagnifyingGlass size={16} weight="bold" className="text-[#737373]" />
              {!collapsed && <span className="flex-1 text-left">Search</span>}
              {!collapsed && <span className="text-[11px] text-[#a3a3a3]">⌘K</span>}
            </button>
          </div>

          {/* Divider */}
          <div className={cn("my-3 border-t border-black/[0.04]", collapsed ? "mx-2" : "mx-1")} />

          {/* Group 2: main entities */}
          <div className="space-y-0.5">
            {navGroup2.map((item) => {
              const isInboxFiltered = item.href === "/inbox" && currentAgentId
              const isActive = !isInboxFiltered && (pathname === item.href || pathname.startsWith(item.href + "/"))
              return <NavItem key={item.href} item={item} isActive={isActive} collapsed={collapsed} />
            })}
          </div>

          {/* Divider */}
          {!collapsed && <div className="my-3 mx-1 border-t border-black/[0.04]" />}

          {/* Group 3: Agents — split by customer-facing vs internal */}
          {!collapsed && (() => {
            const customerAgents = agents.filter(a => a.settings?.is_customer_facing !== false)
            const internalAgents = agents.filter(a => a.settings?.is_customer_facing === false)

            const renderAgent = (a: SidebarAgent) => {
              // Both customer-facing and internal agents land in the
              // inbox view — internal agents use a ChatGPT-style list
              // of the user's own chats + "+ New chat" affordance,
              // driven by settings.is_customer_facing inside inbox/page.
              const href = `/inbox?agentId=${a.id}`
              const isActive = currentAgentId === a.id || pathname === `/agents/${a.id}`
              const menuOpen = agentMenuOpen === a.id
              return (
                <div key={a.id} className="group/agent relative">
                  <Link
                    href={href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] leading-none font-medium transition-colors",
                      isActive ? "bg-white text-[#2e2e2e] shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.04)]" : "text-[#525252] hover:bg-[#ebebeb] hover:text-[#2e2e2e]"
                    )}
                  >
                    <ContactAvatar
                      src={a.avatar_url}
                      name={a.name}
                      seed={a.id}
                      size={16}
                      className="flex-shrink-0"
                    />
                    <span className="truncate flex-1">{a.name}</span>
                    {a.status === "active" && !menuOpen && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0 group-hover/agent:hidden" />}
                  </Link>
                  {/* 3-dot menu */}
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setAgentMenuOpen(menuOpen ? null : a.id) }}
                    className={cn(
                      "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-[#ebebeb] transition-opacity",
                      menuOpen ? "opacity-100" : "opacity-0 group-hover/agent:opacity-100"
                    )}
                    title="More"
                  >
                    <DotsThreeVertical size={14} weight="bold" className="text-[#737373]" />
                  </button>
                  {menuOpen && (
                    <div
                      className="absolute right-1 top-full mt-1 z-20 w-40 rounded-md border border-black/[0.04] bg-white shadow-lg py-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link
                        href={`/agents/${a.id}`}
                        onClick={() => setAgentMenuOpen(null)}
                        className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-[#2e2e2e] hover:bg-[#f5f5f5]"
                      >
                        <GearSix size={14} className="text-[#737373]" />
                        Settings
                      </Link>
                      <button
                        onClick={() => deleteAgent(a.id)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
                      >
                        <SignOut size={14} className="rotate-180" />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )
            }

            const GroupHeader = ({ label, count }: { label: string; count: number }) => (
              <div className="flex items-center justify-between px-3 mb-1">
                <span className="text-xs font-medium text-[#a3a3a3]">{label}</span>
                {count > 0 && <span className="text-xs text-[#a3a3a3]">{count}</span>}
              </div>
            )

            return (
              <div className="space-y-3">
                {/* New agent always visible at the top */}
                <div>
                  <GroupHeader label="Agents" count={agents.length} />
                  <Link
                    href="/agents/new"
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] leading-none font-medium transition-colors",
                      pathname === "/agents/new" ? "bg-white text-[#2e2e2e] shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.04)]" : "text-[#737373] hover:bg-[#ebebeb] hover:text-[#2e2e2e]"
                    )}
                  >
                    <PlusCircle size={16} weight="bold" className="flex-shrink-0 text-[#737373]" />
                    <span className="truncate flex-1">New Agent</span>
                  </Link>
                </div>

                {customerAgents.length > 0 && (
                  <div>
                    <GroupHeader label="Customer-facing" count={customerAgents.length} />
                    <div className="space-y-0.5">{customerAgents.map(renderAgent)}</div>
                  </div>
                )}

                {internalAgents.length > 0 && (
                  <div>
                    <GroupHeader label="Internal" count={internalAgents.length} />
                    <div className="space-y-0.5">{internalAgents.map(renderAgent)}</div>
                  </div>
                )}
              </div>
            )
          })()}
        </nav>

        {/* Bottom nav */}
        <div className="space-y-0.5 border-t border-black/[0.04] px-2 py-2">
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
        <div className="relative border-t border-black/[0.04] px-2 py-2">
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className={cn(
                "flex flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-[#ebebeb]",
                collapsed && "justify-center px-0 flex-none"
              )}
            >
              <ContactAvatar
                name={userName || userEmail}
                seed={userEmail || userName}
                size={28}
                className="flex-shrink-0"
              />
              {!collapsed && (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium text-[#2e2e2e]">{userName || "Loading..."}</div>
                  </div>
                  <CaretDown size={12} weight="bold" className="text-[#a3a3a3]" />
                </>
              )}
            </button>
            <button className="relative rounded-md p-2 text-[#737373] hover:bg-[#ebebeb] hover:text-[#2e2e2e] flex-shrink-0" title="Notifications">
              <Bell size={16} weight="bold" />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#2e2e2e]" />
            </button>
          </div>
          {showUserMenu && (
            <div className={cn(
              "absolute bottom-full mb-1 rounded-lg border border-[#e0e0e0] bg-white p-1 shadow-lg",
              collapsed ? "left-1 w-48" : "left-2 right-2"
            )}>
              <div className="px-3 py-2 border-b border-black/[0.04]">
                <div className="truncate text-sm font-medium text-[#2e2e2e]">{userName}</div>
                <div className="truncate text-[13px] text-[#737373]">{userEmail}</div>
              </div>
              <button
                onClick={handleSignOut}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                <SignOut size={16} weight="bold" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main area */}
      {pathname === "/inbox" || pathname.startsWith("/agents/") ? (
        /* Inbox owns its own layout — no outer header/card */
        <div className="flex flex-1 flex-col overflow-hidden bg-[#f5f5f5]">
          <main className="flex-1 overflow-hidden">{children}</main>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden bg-[#f5f5f5] p-3">
          <div className="flex h-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-black/[0.04]">
            {/* Header (inside card) */}
            <header className="flex h-12 items-center justify-between gap-3 border-b border-black/[0.04] px-5 flex-shrink-0">
              <HeaderTitleArea defaultTitle={pageTitle} />
              {/* Pages mount filters / actions here via <HeaderActions> */}
              <div id="page-header-actions" className="flex items-center gap-2" />
            </header>

            {/* Page content */}
            <main className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </div>
      )}
    </div>
    </PageHeaderTitleProvider>
    </IconContext.Provider>
  )
}
