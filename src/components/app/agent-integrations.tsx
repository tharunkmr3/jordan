"use client"

// ============================================================================
// Agent → Integrations tab
// - Lists integrations currently attached to this agent (with tool config)
// - Browse catalog → attach existing org accounts OR connect new (OAuth popup)
// - Respects org role: "Connect new" gated to admin+
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader } from "@/components/ui/loader"
import { toast } from "sonner"
import { Plug, Search, X, Check, AlertCircle, RefreshCw, Trash2 } from "lucide-react"

type OrgRole = 'owner' | 'admin' | 'agent' | 'viewer'

interface ToolkitCacheRow {
  slug: string
  name: string
  description: string | null
  logo_url: string | null
  categories: string[]
  auth_schemes: string[]
  no_auth: boolean
  is_local: boolean
  tools_count: number
  tags: string[]
}

interface OrgIntegration {
  id: string
  toolkit_slug: string
  connected_account_id: string
  account_label: string | null
  status: string
  status_detail: string | null
  connected_by_user_id: string | null
  last_synced_at: string | null
  created_at: string
}

interface AgentIntegrationRow {
  id: string
  enabled_tools: string[]
  tool_configs: Record<string, Record<string, unknown>>
  attached_by_user_id: string | null
  created_at: string
  updated_at: string
  org_integration:
    | OrgIntegration
    | OrgIntegration[]   // supabase may return array from join
    | null
}

interface ToolRow {
  slug: string
  name: string
  description: string | null
  tags: string[]
}

function flatten(r: AgentIntegrationRow['org_integration']): OrgIntegration | null {
  if (!r) return null
  if (Array.isArray(r)) return r[0] ?? null
  return r
}

function statusPillClass(status: string) {
  switch (status) {
    case 'active': return 'bg-green-50 text-green-700 border border-green-200'
    case 'expired': return 'bg-yellow-50 text-yellow-800 border border-yellow-200'
    case 'revoked':
    case 'failed':  return 'bg-red-50 text-red-700 border border-red-200'
    case 'pending':
    case 'initiated': return 'bg-blue-50 text-blue-700 border border-blue-200'
    default: return 'bg-gray-100 text-gray-700'
  }
}

export function AgentIntegrationsTab({ agentId }: { agentId: string }) {
  const [role, setRole] = useState<OrgRole | null>(null)
  const [attachments, setAttachments] = useState<AgentIntegrationRow[]>([])
  const [orgIntegrations, setOrgIntegrations] = useState<OrgIntegration[]>([])
  const [catalog, setCatalog] = useState<ToolkitCacheRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selectedToolkit, setSelectedToolkit] = useState<ToolkitCacheRow | null>(null)
  const [toolConfigTarget, setToolConfigTarget] = useState<{ attachment: AgentIntegrationRow; integration: OrgIntegration } | null>(null)

  const canConnect = role === 'owner' || role === 'admin'
  const canManage = role === 'owner' || role === 'admin' || role === 'agent'

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 200)
    return () => clearTimeout(t)
  }, [search])

  // Load role
  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(d => setRole(d.role)).catch(() => {})
  }, [])

  const loadAttachments = useCallback(async () => {
    const res = await fetch(`/api/agents/${agentId}/integrations`)
    if (!res.ok) return
    const data = await res.json() as { items: AgentIntegrationRow[] }
    setAttachments(data.items ?? [])
  }, [agentId])

  const loadOrgIntegrations = useCallback(async () => {
    const res = await fetch('/api/integrations/connections')
    if (!res.ok) return
    const data = await res.json() as { items: OrgIntegration[] }
    setOrgIntegrations(data.items ?? [])
  }, [])

  const loadCatalog = useCallback(async (q: string) => {
    const params = new URLSearchParams({ limit: '60', hasAuth: 'true' })
    if (q) params.set('search', q)
    const res = await fetch(`/api/integrations/toolkits?${params}`)
    if (!res.ok) return
    const data = await res.json() as { items: ToolkitCacheRow[] }
    setCatalog(data.items ?? [])
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      await Promise.all([loadAttachments(), loadOrgIntegrations(), loadCatalog(debouncedSearch)])
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  useEffect(() => {
    loadCatalog(debouncedSearch)
  }, [debouncedSearch, loadCatalog])

  // Listen for OAuth popup completion
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data as { source?: string; ok?: boolean; orgIntegrationId?: string; agentId?: string; toolkitSlug?: string; error?: string }
      if (d?.source !== 'jordon:composio-callback') return
      if (d.ok) {
        toast.success(`Connected ${d.toolkitSlug ?? 'integration'}`)
        loadAttachments()
        loadOrgIntegrations()
      } else {
        toast.error(d.error ?? 'Connection failed')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [loadAttachments, loadOrgIntegrations])

  // --- Actions ---------------------------------------------------------------

  const attachExisting = useCallback(async (orgIntegrationId: string) => {
    const res = await fetch(`/api/agents/${agentId}/integrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgIntegrationId, enabledTools: [] }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      toast.error(err.error ?? 'Failed to attach')
      return
    }
    toast.success('Attached. Enable tools next.')
    await loadAttachments()
    setSelectedToolkit(null)
  }, [agentId, loadAttachments])

  const connectNew = useCallback(async (toolkitSlug: string) => {
    const res = await fetch('/api/integrations/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolkitSlug, agentId }),
    })
    const data = await res.json().catch(() => ({})) as { redirectUrl?: string; error?: string }
    if (!res.ok || !data.redirectUrl) {
      toast.error(data.error ?? 'Failed to start OAuth')
      return
    }
    // Open in popup
    const w = 520, h = 680
    const left = Math.max(0, (window.screen.width - w) / 2)
    const top = Math.max(0, (window.screen.height - h) / 2)
    const popup = window.open(data.redirectUrl, 'composio_oauth', `width=${w},height=${h},left=${left},top=${top}`)
    if (!popup) {
      toast.error('Popup blocked. Allow popups for this site and try again.')
    }
  }, [agentId])

  const detach = useCallback(async (attachmentId: string) => {
    if (!confirm('Detach this integration from the agent? (The connection stays in your workspace.)')) return
    const res = await fetch(`/api/agents/${agentId}/integrations/${attachmentId}`, { method: 'DELETE' })
    if (!res.ok) {
      toast.error('Failed to detach')
      return
    }
    toast.success('Detached')
    loadAttachments()
  }, [agentId, loadAttachments])

  const disconnect = useCallback(async (orgIntegrationId: string) => {
    if (!confirm('Disconnect this account from the entire workspace? This affects every agent using it.')) return
    const res = await fetch(`/api/integrations/connections/${orgIntegrationId}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      toast.error(err.error ?? 'Failed to disconnect')
      return
    }
    toast.success('Disconnected')
    loadAttachments()
    loadOrgIntegrations()
  }, [loadAttachments, loadOrgIntegrations])

  // --- Derived state ---------------------------------------------------------

  const attachedOrgIntegrationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const a of attachments) {
      const oi = flatten(a.org_integration)
      if (oi) ids.add(oi.id)
    }
    return ids
  }, [attachments])

  const availableInWorkspace = useMemo(
    () => orgIntegrations.filter(oi => !attachedOrgIntegrationIds.has(oi.id)),
    [orgIntegrations, attachedOrgIntegrationIds]
  )

  // Accounts per toolkit (for the toolkit modal)
  const accountsForSelectedToolkit = useMemo(
    () => selectedToolkit
      ? orgIntegrations.filter(oi => oi.toolkit_slug === selectedToolkit.slug)
      : [],
    [orgIntegrations, selectedToolkit]
  )

  // --- Render ----------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Connected section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-[#2e2e2e]">Connected to this agent</h3>
            <p className="text-xs text-[#737373] mt-0.5">Tools the agent can call during conversations.</p>
          </div>
        </div>

        {loading && attachments.length === 0 ? (
          <div className="flex items-center justify-center py-8"><Loader variant="circular" size="sm" /></div>
        ) : attachments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-black/[0.1] bg-white px-5 py-8 text-center">
            <Plug size={20} className="mx-auto text-[#a3a3a3]" />
            <p className="text-sm text-[#525252] mt-2">No integrations yet.</p>
            <p className="text-xs text-[#737373] mt-1">Attach an existing one or browse the catalog below.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {attachments.map((a) => {
              const oi = flatten(a.org_integration)
              if (!oi) return null
              const toolkit = catalog.find(t => t.slug === oi.toolkit_slug)
              return (
                <div key={a.id} className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.04]">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f5f5f5] overflow-hidden shrink-0">
                    {toolkit?.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={toolkit.logo_url} alt="" className="h-7 w-7 object-contain" />
                    ) : (
                      <Plug size={16} className="text-[#737373]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[#2e2e2e] truncate">{toolkit?.name ?? oi.toolkit_slug}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusPillClass(oi.status)}`}>{oi.status}</span>
                    </div>
                    <div className="text-xs text-[#737373] truncate mt-0.5">
                      {oi.account_label ?? `account ${oi.connected_account_id.slice(0, 10)}`}
                      {' · '}
                      {a.enabled_tools.length} tool{a.enabled_tools.length === 1 ? '' : 's'} enabled
                    </div>
                    {oi.status === 'expired' && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-yellow-800">
                        <AlertCircle size={11} /> Re-authentication needed
                      </div>
                    )}
                  </div>
                  {canManage && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setToolConfigTarget({ attachment: a, integration: oi })}>
                        Configure tools
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => detach(a.id)} title="Detach from this agent">
                        <X size={14} />
                      </Button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Available in workspace */}
      {availableInWorkspace.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-[#2e2e2e] mb-3">Available in workspace</h3>
          <p className="text-xs text-[#737373] -mt-2 mb-3">Connected accounts that other agents in your workspace use. Attach any to this agent.</p>
          <div className="space-y-2">
            {availableInWorkspace.map((oi) => {
              const toolkit = catalog.find(t => t.slug === oi.toolkit_slug)
              return (
                <div key={oi.id} className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 ring-1 ring-black/[0.04]">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f5f5f5] overflow-hidden shrink-0">
                    {toolkit?.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={toolkit.logo_url} alt="" className="h-6 w-6 object-contain" />
                    ) : <Plug size={14} className="text-[#737373]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-[#2e2e2e] truncate">{toolkit?.name ?? oi.toolkit_slug}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusPillClass(oi.status)}`}>{oi.status}</span>
                    </div>
                    <div className="text-xs text-[#737373] truncate">{oi.account_label ?? oi.connected_account_id.slice(0, 16)}</div>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="secondary" onClick={() => attachExisting(oi.id)}>Attach</Button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Browse catalog */}
      <section>
        <div className="flex items-center justify-between mb-3 gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#2e2e2e]">Browse integrations</h3>
            <p className="text-xs text-[#737373] mt-0.5">1000+ services. Click one to connect.</p>
          </div>
          <div className="relative w-64 shrink-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a3a3a3]" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="pl-9 h-9" />
          </div>
        </div>

        {catalog.length === 0 && !loading ? (
          <p className="text-xs text-[#737373] py-6 text-center">No integrations match.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {catalog.map((t) => (
              <button
                key={t.slug}
                onClick={() => setSelectedToolkit(t)}
                className="flex items-center gap-3 rounded-xl bg-white px-3 py-3 ring-1 ring-black/[0.04] text-left hover:ring-black/[0.12] transition"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f5f5f5] overflow-hidden shrink-0">
                  {t.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.logo_url} alt="" className="h-7 w-7 object-contain" />
                  ) : <Plug size={14} className="text-[#737373]" />}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#2e2e2e] truncate">{t.name}</div>
                  <div className="text-[11px] text-[#a3a3a3]">{t.tools_count} tool{t.tools_count === 1 ? '' : 's'}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Toolkit detail modal */}
      {selectedToolkit && (
        <ToolkitModal
          toolkit={selectedToolkit}
          accounts={accountsForSelectedToolkit}
          attachedOrgIntegrationIds={attachedOrgIntegrationIds}
          canConnect={canConnect}
          canManage={canManage}
          onClose={() => setSelectedToolkit(null)}
          onAttach={attachExisting}
          onConnectNew={() => connectNew(selectedToolkit.slug)}
          onDisconnect={disconnect}
        />
      )}

      {/* Tool config drawer */}
      {toolConfigTarget && (
        <ToolConfigDialog
          agentId={agentId}
          attachment={toolConfigTarget.attachment}
          integration={toolConfigTarget.integration}
          onClose={() => setToolConfigTarget(null)}
          onSaved={() => {
            setToolConfigTarget(null)
            loadAttachments()
          }}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Toolkit modal — shows existing accounts + "connect new" CTA
// ----------------------------------------------------------------------------

function ToolkitModal({
  toolkit, accounts, attachedOrgIntegrationIds, canConnect, canManage,
  onClose, onAttach, onConnectNew, onDisconnect,
}: {
  toolkit: ToolkitCacheRow
  accounts: OrgIntegration[]
  attachedOrgIntegrationIds: Set<string>
  canConnect: boolean
  canManage: boolean
  onClose: () => void
  onAttach: (id: string) => void
  onConnectNew: () => void
  onDisconnect: (id: string) => void
}) {
  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#f5f5f5] overflow-hidden">
              {toolkit.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={toolkit.logo_url} alt="" className="h-8 w-8 object-contain" />
              ) : <Plug size={18} className="text-[#737373]" />}
            </div>
            <div>
              <DialogTitle className="text-base">{toolkit.name}</DialogTitle>
              {toolkit.description && <p className="text-xs text-[#737373] mt-0.5 line-clamp-2">{toolkit.description}</p>}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {accounts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-[#525252] mb-2">Existing accounts in your workspace</div>
              <div className="space-y-1.5">
                {accounts.map((acc) => {
                  const isAttached = attachedOrgIntegrationIds.has(acc.id)
                  return (
                    <div key={acc.id} className="flex items-center gap-2 rounded-lg px-3 py-2 bg-[#fafafa]">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[#2e2e2e] truncate">{acc.account_label ?? acc.connected_account_id}</div>
                        <div className="text-[11px] text-[#737373]">{acc.status}</div>
                      </div>
                      {isAttached ? (
                        <Badge variant="secondary" className="text-[10px]"><Check size={10} className="mr-0.5" /> Attached</Badge>
                      ) : canManage ? (
                        <Button size="sm" variant="secondary" onClick={() => onAttach(acc.id)}>Attach</Button>
                      ) : null}
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => onDisconnect(acc.id)} title="Disconnect from workspace">
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-[#525252] mb-2">
              {accounts.length > 0 ? 'Or connect a different account' : 'Connect your first account'}
            </div>
            {canConnect ? (
              <Button onClick={onConnectNew} className="w-full">
                Connect {toolkit.name}
              </Button>
            ) : (
              <p className="text-xs text-[#737373] bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                Only workspace admins can connect new accounts. Ask an admin to connect {toolkit.name}, then you can attach it here.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------
// Tool config dialog — pick which tools the agent can call
// ----------------------------------------------------------------------------

function ToolConfigDialog({
  agentId, attachment, integration, onClose, onSaved,
}: {
  agentId: string
  attachment: AgentIntegrationRow
  integration: OrgIntegration
  onClose: () => void
  onSaved: () => void
}) {
  const [tools, setTools] = useState<ToolRow[]>([])
  const [enabled, setEnabled] = useState<Set<string>>(new Set(attachment.enabled_tools))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")

  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    ;(async () => {
      setLoading(true)
      const res = await fetch(`/api/integrations/toolkits/${integration.toolkit_slug}/tools`)
      if (res.ok) {
        const data = await res.json() as { items: ToolRow[] }
        setTools(data.items ?? [])
      }
      setLoading(false)
    })()
  }, [integration.toolkit_slug])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tools
    return tools.filter(t =>
      t.slug.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      (t.description ?? '').toLowerCase().includes(q)
    )
  }, [tools, search])

  const toggle = (slug: string) => {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  // "Select all" state is scoped to the filtered set — selecting all while
  // a search term is active enables only what's visible, which matches
  // what the user expects to see happen.
  const allVisibleChecked = filtered.length > 0 && filtered.every(t => enabled.has(t.slug))
  const someVisibleChecked = !allVisibleChecked && filtered.some(t => enabled.has(t.slug))
  const toggleAllVisible = () => {
    setEnabled(prev => {
      const next = new Set(prev)
      if (allVisibleChecked) {
        for (const t of filtered) next.delete(t.slug)
      } else {
        for (const t of filtered) next.add(t.slug)
      }
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    const res = await fetch(`/api/agents/${agentId}/integrations/${attachment.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledTools: Array.from(enabled) }),
    })
    setSaving(false)
    if (!res.ok) {
      toast.error('Failed to save tool grants')
      return
    }
    toast.success(`${enabled.size} tool${enabled.size === 1 ? '' : 's'} enabled`)
    onSaved()
  }

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Configure tools · {integration.toolkit_slug}</DialogTitle>
          <p className="text-xs text-[#737373]">Enable only what this agent needs. The AI can only call checked tools.</p>
        </DialogHeader>

        <div className="relative my-2">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a3a3a3]" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter tools…" className="pl-9 h-9" />
        </div>

        {!loading && filtered.length > 0 && (
          <label className="flex items-center gap-3 rounded-lg px-2 py-1.5 cursor-pointer hover:bg-[#fafafa] border-b border-black/[0.04]">
            <Checkbox
              checked={allVisibleChecked}
              indeterminate={someVisibleChecked}
              onCheckedChange={toggleAllVisible}
            />
            <span className="text-sm text-[#2e2e2e]">
              {allVisibleChecked ? 'Deselect all' : 'Select all'}
              {search.trim() && <span className="text-[#a3a3a3]"> · matching &ldquo;{search.trim()}&rdquo;</span>}
            </span>
            <span className="ml-auto text-xs text-[#a3a3a3]">{filtered.length}</span>
          </label>
        )}

        <ScrollArea className="h-80 pr-2">
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader variant="circular" size="sm" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-[#737373] text-center py-6">No tools match.</p>
          ) : (
            <div className="space-y-1">
              {filtered.map(t => {
                const on = enabled.has(t.slug)
                return (
                  <label
                    key={t.slug}
                    className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[#fafafa] cursor-pointer"
                  >
                    <Checkbox checked={on} onCheckedChange={() => toggle(t.slug)} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[#2e2e2e]">{t.name}</div>
                      {t.description && <p className="text-xs text-[#737373] line-clamp-2">{t.description}</p>}
                      <div className="text-[10px] text-[#a3a3a3] mt-0.5 font-mono">{t.slug}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="flex items-center justify-between">
          <div className="text-xs text-[#737373]">{enabled.size} enabled</div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <RefreshCw size={14} className="animate-spin" /> : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
