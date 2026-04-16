"use client"

import { ArrowUpRight, Phone, Globe, MessageCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts"
import { useState } from "react"

const stats = [
  { label: "Conversations", value: "1,284", change: "+12%", period: "vs last month" },
  { label: "Active Agents", value: "3", change: "", period: "across 4 channels" },
  { label: "Avg Response", value: "1.2s", change: "-0.3s", period: "vs last month" },
  { label: "Resolution Rate", value: "87%", change: "+4%", period: "vs last month" },
]

const conversationData = [
  { date: "Mar 1", conversations: 32, resolved: 28 },
  { date: "Mar 4", conversations: 45, resolved: 40 },
  { date: "Mar 7", conversations: 38, resolved: 35 },
  { date: "Mar 10", conversations: 52, resolved: 48 },
  { date: "Mar 13", conversations: 61, resolved: 55 },
  { date: "Mar 16", conversations: 48, resolved: 44 },
  { date: "Mar 19", conversations: 55, resolved: 50 },
  { date: "Mar 22", conversations: 67, resolved: 62 },
  { date: "Mar 25", conversations: 58, resolved: 54 },
  { date: "Mar 28", conversations: 72, resolved: 65 },
  { date: "Mar 31", conversations: 64, resolved: 60 },
  { date: "Apr 3", conversations: 78, resolved: 71 },
  { date: "Apr 6", conversations: 69, resolved: 64 },
  { date: "Apr 10", conversations: 82, resolved: 76 },
]

const channelData = [
  { channel: "WhatsApp", conversations: 486 },
  { channel: "Phone", conversations: 312 },
  { channel: "Website", conversations: 284 },
  { channel: "Facebook", conversations: 202 },
]

const recentConversations = [
  { name: "Priya Sharma", message: "I want to book an appointment for tomorrow", channel: "whatsapp", time: "2m ago", status: "active" },
  { name: "Rahul Patel", message: "What is the status of my order #4521?", channel: "phone", time: "8m ago", status: "resolved" },
  { name: "Anita Desai", message: "Do you deliver to Bangalore?", channel: "facebook", time: "15m ago", status: "resolved" },
  { name: "Vikram Singh", message: "I need to speak with someone about pricing", channel: "web", time: "22m ago", status: "escalated" },
  { name: "Meera Iyer", message: "Thanks for the quick reply!", channel: "whatsapp", time: "34m ago", status: "resolved" },
]

const topQueries = [
  { q: "Order status / tracking", ch: "WhatsApp", count: 312, resolved: "94%" },
  { q: "Appointment booking", ch: "Phone", count: 186, resolved: "89%" },
  { q: "Product pricing inquiry", ch: "Website", count: 145, resolved: "92%" },
  { q: "Return / refund request", ch: "WhatsApp", count: 98, resolved: "78%" },
  { q: "Delivery to my city?", ch: "Facebook", count: 87, resolved: "96%" },
  { q: "Business hours / availability", ch: "Phone", count: 72, resolved: "100%" },
  { q: "Bulk order inquiry", ch: "Website", count: 54, resolved: "85%" },
]

const channelIcon: Record<string, { icon: typeof Phone; color: string }> = {
  whatsapp: { icon: MessageCircle, color: "text-green-600" },
  phone: { icon: Phone, color: "text-foreground" },
  facebook: { icon: MessageCircle, color: "text-blue-600" },
  web: { icon: Globe, color: "text-muted-foreground" },
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; dataKey: string }>; label?: string }) {
  if (!active || !payload) return null
  return (
    <Card className="px-3 py-2 shadow-sm">
      <p className="text-[11px] font-medium text-muted-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-[12px] font-medium">
          {p.dataKey === "conversations" ? "Total" : "Resolved"}: {p.value}
        </p>
      ))}
    </Card>
  )
}

export default function DashboardPage() {
  const [dateRange, setDateRange] = useState("7")

  return (
    <div className="p-6 space-y-6">
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium mr-1">Overview</span>
        <Select value={dateRange} onValueChange={(v) => v && setDateRange(v)}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
        <Select>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="All Channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Channels</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="phone">Phone</SelectItem>
            <SelectItem value="facebook">Facebook</SelectItem>
            <SelectItem value="web">Website</SelectItem>
          </SelectContent>
        </Select>
        <Select>
          <SelectTrigger className="h-8 w-[120px] text-xs">
            <SelectValue placeholder="All Agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            <SelectItem value="support">Support Bot</SelectItem>
            <SelectItem value="sales">Sales Assistant</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-5">
              <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tracking-tight">{stat.value}</span>
                {stat.change && (
                  <Badge variant="secondary" className="text-green-600 bg-green-50 text-[11px] font-medium px-1.5 py-0">
                    {stat.change}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{stat.period}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-3 gap-4">
        {/* Conversations over time */}
        <Card className="col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Conversations</CardTitle>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-blue-600" />
                  <span className="text-[11px] text-muted-foreground">Total</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-gray-300" />
                  <span className="text-[11px] text-muted-foreground">Resolved</span>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={conversationData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity={0.08} />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="conversations" stroke="#2563eb" strokeWidth={2} fill="url(#totalGrad)" dot={false} />
                <Area type="monotone" dataKey="resolved" stroke="#c4c4c4" strokeWidth={1.5} fill="transparent" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* By channel */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">By channel</CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={channelData} layout="vertical" margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis dataKey="channel" type="category" tick={{ fontSize: 12, fill: "hsl(var(--foreground))" }} axisLine={false} tickLine={false} width={70} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
                <Bar dataKey="conversations" fill="#2563eb" radius={[0, 4, 4, 0]} barSize={20} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Top queries */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Top queries</h2>
          <div className="flex items-center gap-2">
            <Input placeholder="Search queries..." className="h-8 w-48 text-xs" />
            <Button variant="outline" size="sm" className="h-8 text-xs">Export</Button>
          </div>
        </div>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Query</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Resolved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topQueries.map((row, i) => (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{row.q}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-xs">{row.ch}</Badge></TableCell>
                  <TableCell className="text-right font-medium">{row.count}</TableCell>
                  <TableCell className="text-right font-medium text-green-600">{row.resolved}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* Recent conversations */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Recent conversations</h2>
          <a href="/inbox" className="text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1">
            View all <ArrowUpRight size={13} />
          </a>
        </div>
        <Card className="gap-0 py-3">
          {recentConversations.map((conv, i) => {
            const ch = channelIcon[conv.channel]
            const ChIcon = ch.icon
            return (
              <a
                key={i}
                href="/inbox"
                className="flex items-center gap-4 px-5 py-3 hover:bg-[#fafafa] transition-colors"
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs font-semibold bg-muted">
                    {conv.name.split(" ").map(n => n[0]).join("")}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{conv.name}</span>
                    <ChIcon size={13} className={ch.color} />
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{conv.message}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <Badge
                    variant={conv.status === "active" ? "default" : "secondary"}
                    className={
                      conv.status === "active" ? "bg-green-50 text-green-700 hover:bg-green-50" :
                      conv.status === "escalated" ? "bg-orange-50 text-orange-700 hover:bg-orange-50" :
                      ""
                    }
                  >
                    {conv.status}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">{conv.time}</span>
                </div>
              </a>
            )
          })}
        </Card>
      </div>
    </div>
  )
}
