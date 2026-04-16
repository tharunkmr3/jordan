"use client"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TableWidget } from "@/lib/ui-widgets/schemas"

function cellToString(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "boolean") return v ? "Yes" : "No"
  return String(v)
}

export function AiTableWidget({ widget }: { widget: TableWidget }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-black/[0.04] p-3 space-y-2 text-[13px]">
      {widget.title && <div className="text-sm font-semibold text-[#2e2e2e] px-1">{widget.title}</div>}
      <Table>
        <TableHeader>
          <TableRow>
            {widget.columns.map((c) => (
              <TableHead key={c.key}>{c.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {widget.rows.map((row, i) => (
            <TableRow key={i}>
              {widget.columns.map((c) => (
                <TableCell key={c.key}>{cellToString(row[c.key] as string | number | boolean | null | undefined)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
