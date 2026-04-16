import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Card padding tiers. Controls vertical padding + gap on the card
 * and horizontal padding on CardHeader / CardContent / CardFooter.
 *
 * - xs  → py-2 / gap-2 / px-3   (compact chips, stat tiles)
 * - sm  → py-3 / gap-3 / px-3   (single-metric cards)
 * - md  → py-4 / gap-4 / px-4   (default)
 * - lg  → py-5 / gap-5 / px-5   (feature panels)
 * - xl  → py-6 / gap-6 / px-6   (hero cards, empty states)
 */
export type CardSize = "xs" | "sm" | "md" | "lg" | "xl"

function Card({
  className,
  size = "md",
  ...props
}: React.ComponentProps<"div"> & { size?: CardSize }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl bg-card text-sm text-card-foreground ring-1 ring-black/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.04)]",
        // Size-driven vertical padding and inter-child gap
        "data-[size=xs]:gap-2 data-[size=xs]:py-2",
        "data-[size=sm]:gap-3 data-[size=sm]:py-3",
        "data-[size=md]:gap-4 data-[size=md]:py-4",
        "data-[size=lg]:gap-5 data-[size=lg]:py-5",
        "data-[size=xl]:gap-6 data-[size=xl]:py-6",
        // Table auto-padding matches the size tier
        "has-[>[data-slot=table-container]]:data-[size=xs]:px-3",
        "has-[>[data-slot=table-container]]:data-[size=sm]:px-3",
        "has-[>[data-slot=table-container]]:data-[size=md]:px-4",
        "has-[>[data-slot=table-container]]:data-[size=lg]:px-5",
        "has-[>[data-slot=table-container]]:data-[size=xl]:px-6",
        // Footer hugs the bottom edge; images bleed to the top
        "has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0",
        "*:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl",
        "group-data-[size=xs]/card:px-3 group-data-[size=sm]/card:px-3 group-data-[size=md]/card:px-4 group-data-[size=lg]/card:px-5 group-data-[size=xl]/card:px-6",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]",
        "group-data-[size=xs]/card:[.border-b]:pb-2 group-data-[size=sm]/card:[.border-b]:pb-3 group-data-[size=md]/card:[.border-b]:pb-4 group-data-[size=lg]/card:[.border-b]:pb-5 group-data-[size=xl]/card:[.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading leading-snug font-medium",
        "group-data-[size=xs]/card:text-sm group-data-[size=sm]/card:text-sm group-data-[size=md]/card:text-base group-data-[size=lg]/card:text-base group-data-[size=xl]/card:text-lg",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(
        "group-data-[size=xs]/card:px-3 group-data-[size=sm]/card:px-3 group-data-[size=md]/card:px-4 group-data-[size=lg]/card:px-5 group-data-[size=xl]/card:px-6",
        className
      )}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50",
        "group-data-[size=xs]/card:p-2 group-data-[size=sm]/card:p-3 group-data-[size=md]/card:p-4 group-data-[size=lg]/card:p-5 group-data-[size=xl]/card:p-6",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
