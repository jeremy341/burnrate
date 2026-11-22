import type { ComponentType } from "react";
import type { Loaded } from "~/api";
import type { LimitsReport, ProviderInfo } from "~/contracts";

export interface ViewProps {
  readonly providers: Loaded<readonly ProviderInfo[]>;
  readonly limits: Loaded<LimitsReport>;
  /** Returns to the Usage view. */
  readonly close: () => void;
}

/** A top-level screen. Drop a file `src/views/<id>.tsx` that exports `view: ViewDef`; it appears in the screen menu (the "Usage" breadcrumb segment) and the command palette. */
export interface ViewDef {
  readonly id: string;
  readonly title: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Menu order, ascending. */
  readonly order: number;
  /** Show a refresh button (re-reads the limits) on the right of this screen's header. Defaults to true for Providers. */
  readonly refreshLimits?: boolean;
  readonly Component: ComponentType<ViewProps>;
}
