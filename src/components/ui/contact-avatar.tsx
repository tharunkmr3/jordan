"use client"

import { Phone } from "@phosphor-icons/react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { avatarColor, avatarInitial, isPhoneNumber, cn } from "@/lib/utils"

interface ContactAvatarProps {
  /** Image URL. Takes precedence over the fallback when loaded. */
  src?: string | null
  /**
   * The display name (preferred) or phone number (triggers phone icon
   * fallback). Used both for initial extraction and color seeding.
   */
  name?: string | null
  /**
   * Stable seed for color derivation. Defaults to `name`. Use a
   * user/contact id here if the name can change so the color stays
   * stable when someone renames themselves.
   */
  seed?: string | null
  /** Avatar size in px. Defaults to 36. */
  size?: number
  /** Extra classes for the outer Avatar root. */
  className?: string
}

/**
 * One-stop avatar for contacts, agents, and users.
 *
 * Rules (from the design system):
 * - If `src` is a valid image URL, show it.
 * - Otherwise if we can extract a single letter from the name, show it
 *   on a color-coded medium pastel bg with deep hue-matched text.
 * - Otherwise (phone number / empty / numeric id) show a Phone icon on
 *   the same color-coded bg.
 *
 * Only ever shows a single letter — never two initials.
 */
export function ContactAvatar({
  src,
  name,
  seed,
  size = 36,
  className,
}: ContactAvatarProps) {
  const colorSeed = seed ?? name ?? ""
  const c = avatarColor(colorSeed)
  const initial = avatarInitial(name)
  const usePhoneIcon = !initial && (!name || isPhoneNumber(name))

  // Scale the glyph roughly linearly with avatar size. 36px → ~14px
  // letter / ~15px icon; 24px → ~10px / ~10px.
  const letterFontSize = Math.max(10, Math.round(size * 0.4))
  const iconSize = Math.max(10, Math.round(size * 0.42))

  return (
    <Avatar
      className={cn("rounded-full after:hidden", className)}
      style={{ width: size, height: size }}
    >
      {src && <AvatarImage src={src} alt={name || ""} />}
      <AvatarFallback className={cn("font-semibold", c.bg, c.text)}>
        {usePhoneIcon ? (
          // Filled glyph softened with opacity so the phone reads as a
          // quiet hint, not a primary focal element.
          <Phone size={iconSize} weight="fill" className="opacity-60" />
        ) : (
          <span style={{ fontSize: letterFontSize, lineHeight: 1 }}>{initial}</span>
        )}
      </AvatarFallback>
    </Avatar>
  )
}
