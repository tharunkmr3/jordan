/**
 * Generative UI — schemas the AI can emit inside a ```ui code block.
 *
 * Keep these schemas lean. Every field we add is one more thing the
 * model can hallucinate or misuse, and one more thing for us to
 * render reliably. Start narrow, add only when a real use case shows
 * up. Graceful-degradation default: anything that fails validation
 * falls back to a plain `<pre>` in the markdown renderer — the chat
 * never crashes on a bad payload.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// form — ask the user for a set of typed fields before acting
// ---------------------------------------------------------------------------

const FieldCommon = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
})

const TextField = FieldCommon.extend({
  type: z.literal("text").or(z.literal("email")).or(z.literal("url")).optional(),
  default: z.string().optional(),
})

const TextareaField = FieldCommon.extend({
  type: z.literal("textarea"),
  rows: z.number().int().positive().max(10).optional(),
  default: z.string().optional(),
})

const NumberField = FieldCommon.extend({
  type: z.literal("number"),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.number().optional(),
})

const SelectField = FieldCommon.extend({
  type: z.literal("select"),
  options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
  default: z.string().optional(),
})

const BooleanField = FieldCommon.extend({
  type: z.literal("boolean"),
  default: z.boolean().optional(),
})

const FormField = z.discriminatedUnion("type", [
  TextareaField,
  NumberField,
  SelectField,
  BooleanField,
  // Text is the fallback — anything without `type` or with text/email/url is a text input.
  // We put a discriminator on it by defaulting during normalize, see below.
  TextField.extend({ type: z.literal("text") }),
  TextField.extend({ type: z.literal("email") }),
  TextField.extend({ type: z.literal("url") }),
])

export const FormWidgetSchema = z.object({
  type: z.literal("form"),
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(FormField).min(1).max(12),
  submit: z
    .object({
      label: z.string().default("Submit"),
      /** Free-text action hint for the model on the next turn (not a server call). */
      action: z.string().optional(),
    })
    .default({ label: "Submit" }),
  cancel: z
    .object({ label: z.string().default("Cancel") })
    .optional(),
})

export type FormWidget = z.infer<typeof FormWidgetSchema>

// ---------------------------------------------------------------------------
// confirm — single yes/no gate before a destructive or expensive action
// ---------------------------------------------------------------------------

export const ConfirmWidgetSchema = z.object({
  type: z.literal("confirm"),
  title: z.string().optional(),
  /** The main question / body text. Rendered as plain text (no markdown). */
  message: z.string().min(1),
  confirm: z.object({
    label: z.string().default("Confirm"),
    /** Reply sent back to the agent when the user clicks confirm. */
    value: z.string().optional(),
    /** Visual intent; destructive shows red. */
    variant: z.enum(["default", "destructive"]).default("default"),
  }),
  cancel: z
    .object({
      label: z.string().default("Cancel"),
      value: z.string().optional(),
    })
    .optional(),
})

export type ConfirmWidget = z.infer<typeof ConfirmWidgetSchema>

// ---------------------------------------------------------------------------
// choice — pick one of N (disambiguation)
// ---------------------------------------------------------------------------

export const ChoiceWidgetSchema = z.object({
  type: z.literal("choice"),
  title: z.string().optional(),
  description: z.string().optional(),
  options: z
    .array(
      z.object({
        /** Sent back as the user's reply when this option is picked. */
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      })
    )
    .min(2)
    .max(8),
})

export type ChoiceWidget = z.infer<typeof ChoiceWidgetSchema>

// ---------------------------------------------------------------------------
// card — structured info display (title + field list + optional action)
// ---------------------------------------------------------------------------

export const CardWidgetSchema = z.object({
  type: z.literal("card"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  fields: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .max(12)
    .optional(),
  /** Optional trailing action button. Click posts `action` back to the agent. */
  action: z
    .object({
      label: z.string(),
      value: z.string(),
      variant: z.enum(["default", "secondary", "destructive"]).default("default"),
    })
    .optional(),
})

export type CardWidget = z.infer<typeof CardWidgetSchema>

// ---------------------------------------------------------------------------
// table — simple data table with typed columns
// ---------------------------------------------------------------------------

export const TableWidgetSchema = z.object({
  type: z.literal("table"),
  title: z.string().optional(),
  columns: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .min(1)
    .max(8),
  /** Rows are objects keyed by column.key. Cell values coerced to string. */
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(50),
})

export type TableWidget = z.infer<typeof TableWidgetSchema>

// ---------------------------------------------------------------------------
// Top-level union — try to parse any incoming ```ui block as one of these.
// ---------------------------------------------------------------------------

export const WidgetSchema = z.discriminatedUnion("type", [
  FormWidgetSchema,
  ConfirmWidgetSchema,
  ChoiceWidgetSchema,
  CardWidgetSchema,
  TableWidgetSchema,
])

export type Widget = z.infer<typeof WidgetSchema>

/**
 * Parse a ```ui code block body into a validated Widget.
 * Returns `null` (never throws) so the markdown renderer can fall
 * back gracefully to showing the raw JSON.
 */
export function parseWidget(raw: string): Widget | null {
  try {
    const json = JSON.parse(raw)
    const result = WidgetSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
