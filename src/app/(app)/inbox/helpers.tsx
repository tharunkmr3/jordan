"use client"

import { ChannelIcon } from '@/components/ui/channel-icon'
import type { ChannelType } from './types'

/**
 * Shared pure-formatting helpers used by both the internal and
 * customer-facing chat views + the conversation list. Kept here so
 * both views stay in sync on timestamp / channel / truncation
 * conventions.
 */

export function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

export function formatTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function channelIcon(channel: ChannelType, size = 14) {
  switch (channel) {
    case 'whatsapp':
      return <ChannelIcon kind="whatsapp" size={size} className="text-[#25D366]" />
    case 'facebook':
      return <ChannelIcon kind="messenger" size={size} className="text-[#0084FF]" />
    case 'phone':
      return <ChannelIcon kind="phone" size={size} className="text-[#a855f7]" />
    case 'website':
    default:
      return <ChannelIcon kind="website" size={size} className="text-[#f59e0b]" />
  }
}

export function channelLabel(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'facebook':
      return 'Messenger'
    case 'phone':
      return 'Phone'
    case 'website':
    default:
      return 'Website'
  }
}

export function channelBg(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'bg-[#e7f8f0] text-[#25D366]'
    case 'facebook':
      return 'bg-[#e5f1ff] text-[#0084FF]'
    case 'phone':
      return 'bg-[#f3e8ff] text-[#a855f7]'
    case 'website':
    default:
      return 'bg-[#fef3c7] text-[#f59e0b]'
  }
}

export function truncate(str: string | undefined | null, len: number): string {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '...' : str
}
