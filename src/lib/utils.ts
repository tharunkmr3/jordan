import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Deterministic avatar color from a string (name or id).
// Returns Tailwind classes for bg + text. Medium-saturated pastel bg
// with a deep hue-matched text so the glyph reads as "tinted dark"
// rather than a colored letter.
const AVATAR_PALETTE = [
  { bg: "bg-blue-200",    text: "text-blue-900" },
  { bg: "bg-emerald-200", text: "text-emerald-900" },
  { bg: "bg-amber-200",   text: "text-amber-900" },
  { bg: "bg-purple-200",  text: "text-purple-900" },
  { bg: "bg-pink-200",    text: "text-pink-900" },
  { bg: "bg-cyan-200",    text: "text-cyan-900" },
  { bg: "bg-orange-200",  text: "text-orange-900" },
  { bg: "bg-indigo-200",  text: "text-indigo-900" },
  { bg: "bg-rose-200",    text: "text-rose-900" },
  { bg: "bg-teal-200",    text: "text-teal-900" },
]

export function avatarColor(seed: string | null | undefined): { bg: string; text: string } {
  if (!seed) return AVATAR_PALETTE[0]
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

/**
 * First visible character from a name, uppercased. Used for avatar
 * fallbacks. Returns null if the name is empty, a phone number, or
 * obviously machine-generated (all-digit IDs, etc.) — the caller
 * should render a phone icon instead.
 */
export function avatarInitial(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  if (isPhoneNumber(trimmed)) return null
  const ch = trimmed[0]
  if (!/[a-zA-Z]/.test(ch)) return null
  return ch.toUpperCase()
}

/**
 * Rough phone-number detector. True for strings that are mostly
 * digits / +/space/dash/parens — the stuff you'd see in a contact
 * identifier that came in as a raw phone number.
 */
export function isPhoneNumber(s: string): boolean {
  if (!s) return false
  // Must have at least 7 digits to count as a phone number
  const digits = s.replace(/\D/g, "")
  if (digits.length < 7) return false
  // Only allow the shape of a phone number (digits + common separators)
  return /^[+\d\s\-().]+$/.test(s)
}
