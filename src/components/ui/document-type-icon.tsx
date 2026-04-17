"use client"

// ============================================================================
// <DocumentTypeIcon>
//
// Renders a file-format-specific icon in place of a generic document glyph.
// Uses Phosphor's built-in filetype set (already a project dep) so we stay
// consistent with the rest of the app's icon language — same weight, same
// stroke width, same rendering.
//
// Each format gets a subtle color tint so users can scan a file list by
// type at a glance: PDFs are red, Word docs blue, Excel green, etc. The
// tints are muted enough to read as UI chrome, not "rainbow clown table".
// ============================================================================

import * as React from "react"
import {
  FilePdf,
  FileDoc,
  FileXls,
  FilePpt,
  FileCsv,
  FileText,
  FileImage,
  FileCode,
  FileZip,
  FileAudio,
  FileVideo,
  File,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

interface Props {
  /** Full filename — used to derive the extension. Preferred over fileType
      because file.type can be blank or wrong for niche formats. */
  name: string
  /** MIME type fallback if the extension isn't recognized. */
  fileType?: string | null
  size?: number
  className?: string
}

export function DocumentTypeIcon({ name, fileType, size = 18, className }: Props) {
  const { Icon, color } = pickIcon(name, fileType)
  return <Icon size={size} weight="fill" className={cn(color, "shrink-0", className)} />
}

// ---------------------------------------------------------------------------
// Icon dispatch — centralized so the mapping is trivial to extend.
// ---------------------------------------------------------------------------

type IconDef = { Icon: PhosphorIcon; color: string }

function pickIcon(name: string, fileType: string | null | undefined): IconDef {
  const n = name.toLowerCase()
  const t = (fileType ?? "").toLowerCase()

  if (n.endsWith(".pdf") || t === "application/pdf") {
    return { Icon: FilePdf, color: "text-red-500" }
  }
  if (n.endsWith(".doc") || n.endsWith(".docx") ||
      t === "application/msword" ||
      t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { Icon: FileDoc, color: "text-blue-600" }
  }
  if (n.endsWith(".xls") || n.endsWith(".xlsx") || n.endsWith(".xlsm") ||
      t === "application/vnd.ms-excel" ||
      t === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return { Icon: FileXls, color: "text-emerald-600" }
  }
  if (n.endsWith(".ppt") || n.endsWith(".pptx") ||
      t === "application/vnd.ms-powerpoint" ||
      t === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return { Icon: FilePpt, color: "text-orange-500" }
  }
  if (n.endsWith(".csv") || n.endsWith(".tsv") || t === "text/csv") {
    return { Icon: FileCsv, color: "text-green-600" }
  }
  if (n.endsWith(".json") || n.endsWith(".yaml") || n.endsWith(".yml") || n.endsWith(".toml")) {
    return { Icon: FileCode, color: "text-amber-600" }
  }
  if (n.endsWith(".js") || n.endsWith(".ts") || n.endsWith(".tsx") || n.endsWith(".jsx") ||
      n.endsWith(".html") || n.endsWith(".css") || n.endsWith(".py") || n.endsWith(".go") ||
      n.endsWith(".rs") || n.endsWith(".java") || n.endsWith(".rb") || n.endsWith(".sh")) {
    return { Icon: FileCode, color: "text-sky-600" }
  }
  if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt") || n.endsWith(".log")) {
    return { Icon: FileText, color: "text-[#737373]" }
  }
  if (t.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif)$/.test(n)) {
    return { Icon: FileImage, color: "text-violet-500" }
  }
  if (t.startsWith("audio/") || /\.(mp3|wav|flac|m4a|ogg)$/.test(n)) {
    return { Icon: FileAudio, color: "text-pink-500" }
  }
  if (t.startsWith("video/") || /\.(mp4|mov|mkv|avi|webm)$/.test(n)) {
    return { Icon: FileVideo, color: "text-rose-500" }
  }
  if (/\.(zip|tar|gz|7z|rar)$/.test(n)) {
    return { Icon: FileZip, color: "text-yellow-600" }
  }
  return { Icon: File, color: "text-[#737373]" }
}
