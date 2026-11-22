import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

/**
 * - `readable`: prose-like pages; stays a column even on a big monitor.
 * - `wide`: dashboards (Usage, Providers). A comfortable measure up to 1280px, then it uses
 *   the window instead of a centered 1024px strip, and only stops growing past ~1920px.
 * - `expanded`: same as `wide`, for pages that want the room sooner (from 1024px).
 * - `form`: Settings rows (title left, control right). Capped at 45rem on small windows, 56rem from 1280px:
 *   a form that spans a 1920px window is harder to scan, not easier.
 * - `usage`: T3's Usage window, 1:1: a 1024px column at every width with T3's own page padding
 *   (`px-5 pt-6 pb-12 sm:px-6`), so the screen reads the same as T3's usage monitor.
 *
 * The horizontal padding never changes with width: it must keep matching the header gutter
 * (`--workspace-gutter`, the `px-3 sm:px-5` of PAGE_RHYTHM) so the breadcrumb and the first column stay aligned.
 * Only `usage` brings its own padding.
 */
export type WorkspacePageWidth = "readable" | "wide" | "expanded" | "form" | "usage";

export const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-4xl 2xl:max-w-5xl",
  wide: "max-w-5xl xl:max-w-none 2xl:max-w-[120rem]",
  expanded: "max-w-6xl lg:max-w-none 2xl:max-w-[120rem]",
  form: "max-w-[45rem] xl:max-w-4xl",
  usage: "max-w-5xl px-5 pt-6 pb-12 sm:px-6",
};

/**
 * The one page rhythm every screen shares: gutters equal the header's, sections sit 24px apart and the
 * first one 16px below the bar. It lives here so a break at 320 / 640 / 1100px is fixed once, not per screen.
 */
export const PAGE_RHYTHM = "gap-6 px-3 pt-4 pb-8 sm:px-5";

export function WorkspacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return (
    <div
      data-page-width={width}
      className={cn("mx-auto flex w-full min-w-0 flex-col", PAGE_RHYTHM, WIDTH_CLASS[width], className)}
      {...props}
    />
  );
}
