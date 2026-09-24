import { z } from "zod";
import { AssetClass, CapabilitySchema, FreshnessSchema } from "./schemas.js";

export const WidgetKindSchema = z.enum([
  "quote-card",
  "sparkline",
  "candlestick",
  "option-chain",
  "greeks-grid",
  "news-feed",
  "position-table",
  "pnl-summary",
  "transaction-form",
  "transaction-history",
  "pnl-card",
  "health-badge",
  "research-journal",
  "trading-review",
  "broker-accounts",
  "account-settings",
]);
export type WidgetKind = z.infer<typeof WidgetKindSchema>;

export const WidgetDescriptorSchema = z.object({
  id: z.string(),
  kind: WidgetKindSchema,
  title: z.string(),
  dataEndpoint: z.string(),
  requiredCapabilities: z.array(CapabilitySchema),
  // Zod's runtime accepts the one-argument form required by DESIGN.md;
  // the installed declaration still exposes the older signature.
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  fieldMap: z.record(z.string()),
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  options: z.record(z.unknown()).default({}),
});
export type WidgetDescriptor = z.infer<typeof WidgetDescriptorSchema>;

export const PanelDescriptorSchema = z.object({
  panelId: z.string(),
  instrumentId: z.string(),
  title: z.string(),
  assetClass: AssetClass,
  widgets: z.array(WidgetDescriptorSchema),
  availableCapabilities: z.array(CapabilitySchema),
  freshness: FreshnessSchema.nullable(),
});
export type PanelDescriptor = z.infer<typeof PanelDescriptorSchema>;

export const SectionDescriptorSchema = z.object({
  id: z.string(),
  title: z.string(),
  order: z.number().int(),
  showPositionSummary: z.boolean().default(false),
  panels: z.array(PanelDescriptorSchema),
});
export type SectionDescriptor = z.infer<typeof SectionDescriptorSchema>;

export const ViewDescriptorSchema = z.object({
  viewId: z.string(),
  title: z.string(),
  sections: z.array(SectionDescriptorSchema).default([]),
  layout: z.array(z.object({
    widgetId: z.string(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })),
  panels: z.array(PanelDescriptorSchema),
});
export type ViewDescriptor = z.infer<typeof ViewDescriptorSchema>;
