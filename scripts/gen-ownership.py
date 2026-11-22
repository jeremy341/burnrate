"""Generates docs/work/ownership.json (package id -> owned globs) and checks for overlaps. Run from the repo root."""
import json, re, subprocess

P = {}


def pk(id, name, wave, globs, deps=""):
    P[id] = {"name": name, "wave": wave, "globs": globs, "deps": deps}


R = "server-rs/src/"
pk("01", "settings-store", "A", [R + "settings.rs", R + "routes/settings_api.rs"])
pk("02", "themes-proxy", "A", [R + "themes.rs", R + "routes/themes_api.rs"])
pk("03", "defs-engine", "A", [R + "defs/**", R + "routes/defs_api.rs"])
pk("04", "budgets", "A", [R + "budgets.rs", R + "routes/budgets_api.rs"])
pk("05", "net-guard-keys", "A", [R + "net_guard.rs", R + "keys.rs", R + "diagnostics.rs", R + "routes/secrets_api.rs", R + "routes/diagnostics_api.rs"])
pk("06", "history", "A", [R + "history.rs", R + "routes/history_api.rs"])
pk("07", "alerts-engine", "A", [R + "alerts/**", R + "routes/alerts_api.rs"])
pk("08", "scheduler-hub-status", "A", [R + "scheduler.rs", R + "hub.rs", R + "routes/status_api.rs"])
pk("09", "readers-extra", "A", [R + "readers/**", R + "pricing.rs"])
pk("10", "claude-statusline", "A", [R + "providers/**", R + "routes/ingest_api.rs"])
pk("11", "cli", "A", ["cli/**"])
pk("12", "shell", "A", ["src-tauri/**"])
D = "server-rs/defs/"
pk("13", "defs-openrouter-deepseek", "A", [D + "openrouter.toml", D + "deepseek.toml", D + "fixtures/openrouter*.json", D + "fixtures/deepseek*.json"])
pk("14", "defs-moonshot-kimi", "A", [D + "moonshot.toml", D + "kimi-code.toml", D + "fixtures/moonshot*.json", D + "fixtures/kimi*.json"])
pk("15", "defs-xai-zai", "A", [D + "xai.toml", D + "zai.toml", D + "fixtures/xai*.json", D + "fixtures/zai*.json"])
pk("16", "defs-admin-apis", "A", [D + "openai-admin.toml", D + "anthropic-admin.toml", D + "fixtures/openai*.json", D + "fixtures/anthropic*.json"])
pk("17", "defs-copilot-kiro-windsurf", "A", [D + "copilot.toml", D + "kiro.toml", D + "windsurf.toml", D + "fixtures/copilot*.json", D + "fixtures/kiro*.json", D + "fixtures/windsurf*.json"])
pk("18", "defs-ollama-groq-perplexity-together", "A", [D + "ollama.toml", D + "groq.toml", D + "perplexity.toml", D + "together.toml", D + "fixtures/ollama*.json", D + "fixtures/groq*.json", D + "fixtures/perplexity*.json", D + "fixtures/together*.json"])
pk("19", "defs-gemini-cloud", "A", [D + "gemini.toml", D + "vertex.toml", D + "azure-openai.toml", D + "bedrock.toml", D + "fixtures/gemini*.json", D + "fixtures/vertex*.json", D + "fixtures/azure*.json", D + "fixtures/bedrock*.json"])
pk("20", "defs-catalog", "A", [D + "catalog.json", D + "_example.toml", D + "README.md", "docs/PROVIDER-DEFINITIONS.md", "scripts/build-catalog.mjs"])
pk("21", "theme-core", "A", ["src/themePalette.ts", "src/themeCss.ts", "src/appearanceContrast.ts", "src/appearance.ts", "src/hooks/useTheme.ts", "src/hooks/useCustomThemes.ts", "src/themes/engine/**", "src/themes/store.ts", "src/theme-dark.css", "index.html", "src/main.tsx", "src/themes/registry.ts"])
pk("22", "theme-editor", "B", ["src/components/settings/ThemeEditor*.tsx", "src/components/settings/ThemeColorPicker.tsx", "src/components/settings/ThemeCssEditor.tsx", "src/components/settings/ThemePreviewCircles.tsx", "src/components/settings/ThemeWireframe.tsx", "src/components/settings/themeEditorStore.ts", "src/components/settings/themeInspector.ts"], "21,26")
pk("23", "theme-import", "B", ["src/vscodeThemeImport.ts", "src/openVsxThemes.ts", "src/components/settings/ThemeImportDialog.tsx", "src/components/settings/ThemeSearchSection.tsx", "src/api/themes.ts"], "21")
pk("24", "appearance-extras", "B", ["src/appearance.css", "src/components/settings/Typography*.tsx", "src/components/settings/FontFamilyPicker.tsx", "src/components/settings/SettingsFontPreviews.tsx", "src/appearanceFonts.ts", "src/themes/presets/**", "docs/THEME.md"], "21,26")
pk("25", "settings-shell", "A", ["src/settings/SettingsPage.tsx", "src/settings/registry.ts", "src/settings/types.ts", "src/settings/layout.tsx", "src/settings/search.ts", "src/views/settings.tsx", "src/components/settings/SettingsGroup.tsx", "src/components/settings/FoldedSettingsSection.tsx", "src/components/skeletons/SettingsSkeleton.tsx", "src/settings/settings.css"])
pk("26", "settings-store-client", "A", ["src/settings/store.ts", "src/settings/schema.ts", "src/settings/migrate.ts", "src/hooks/useSettings.ts", "src/api/settings.ts", "src/settings/*.test.ts"])
S = "src/settings/sections/"
pk("27", "sec-general", "A", [S + "general.tsx"])
pk("28", "sec-appearance", "B", [S + "appearance.tsx", "src/components/settings/ThemeSettings.tsx", "src/components/settings/AppearanceSettingsPanel.tsx"], "21,22,26")
pk("29", "sec-usage", "A", [S + "usage.tsx", "src/api/budgets.ts", "src/components/settings/BudgetEditor.tsx"])
pk("30", "sec-providers-defs", "A", [S + "providers.tsx", "src/api/defs.ts", "src/components/definitions/DefinitionEditor.tsx"])
pk("31", "sec-notifications", "A", [S + "notifications.tsx", "src/api/alerts.ts", "src/api/secrets.ts", "src/components/settings/ChannelSecretField.tsx"])
pk("32", "sec-shortcuts", "A", [S + "shortcuts.tsx", "src/settings/shortcuts.ts"])
pk("33", "sec-shell-advanced", "A", [S + "advanced.tsx"])
pk("34", "sec-data", "A", [S + "data.tsx", "src/settings/transfer.ts"])
pk("35", "sec-about", "A", [S + "about.tsx", "src/api/diagnostics.ts", "src/components/settings/DiagnosticsPanel.tsx"])
pk("38", "app-shell", "A", ["src/App.tsx", "src/components/AppHeader.tsx", "src/components/WorkspacePageContainer.tsx", "src/components/WorkspaceBreadcrumb.tsx", "src/components/ui/app-nav.ts", "src/components/ui/app-shell.tsx", "src/components/AppModalFrame.tsx", "src/state/usage.ts", "src/lib/locale.ts", "src/t3-shims/gt-react.ts", "src/AppProviders.tsx", "src/views/registry.ts", "src/views/types.ts"])
pk("39", "limits-a11y", "A", ["src/components/usage/UsageLimits.tsx", "src/components/usage/UsageLimitsPooled.tsx", "src/components/usage/usageProviders.ts", "src/shared/usageLimits*.ts", "src/shared/usageMerge.ts", "src/shared/usageProgress.ts", "src/a11y.css"])
pk("40", "toast-system", "A", ["src/overlays/toast.tsx", "src/lib/toast/**"])
pk("41", "command-palette", "A", ["src/overlays/palette.tsx", "src/palette/**"])
pk("42", "onboarding", "A", ["src/overlays/onboarding.tsx", "src/onboarding/**"])
pk("43", "alerts-client", "A", ["src/overlays/alerts.tsx", "src/alerts/**"])
pk("47", "providers-wizard", "A", ["src/ProvidersPage.tsx", "src/views/providers.tsx", "src/components/providers/*.tsx", "src/components/providers/*.ts", "src/components/skeletons/ProvidersSkeleton.tsx", "src/api.ts", "src/api/catalog.ts", "src/providers/**"])
pk("48", "packaging", "A", ["packaging/**", ".github/**"])
pk("49", "perf-budget", "A", ["scripts/perf-*.mjs", "docs/PERFORMANCE.md", "vite.config.ts"])
pk("50", "smoke-e2e", "A", ["scripts/smoke/**"])
pk("51", "usage-screen", "A", ["src/components/usage/UsagePage.tsx", "src/components/usage/UsageProviderChart.tsx", "src/components/usage/UsageModelDialog.tsx", "src/components/usage/UsageScanStatus.tsx", "src/components/usage/UsageShareBar.tsx", "src/components/usage/UsageTableRegion.tsx", "src/components/usage/UsagePriceOverrides.tsx", "src/components/usage/UsageLimitsStates.tsx", "src/components/usage/UsageLimitsCollapse.tsx", "src/components/usage/usageBreakdown.ts", "src/components/usage/usageCollapse.ts", "src/components/usage/usagePagePreferences.ts", "src/components/usage/usagePriceForm.ts", "src/components/usage/usagePriceTable.ts", "src/components/usage/usagePriceTargets.ts", "src/components/usage/usageShortcuts.ts", "src/components/usage/usageMarkColor.ts", "src/components/usage/externalLinks.ts", "src/components/skeletons/UsageSkeleton.tsx", "src/components/skeletons/LimitsSkeleton.tsx"])

json.dump({"note": "Package id -> owned globs. Run: node scripts/check-ownership.mjs <id> [base]. Files not listed are integrator-owned.", "packages": P}, open("docs/work/ownership.json", "w"), indent=1)


def rx(g):
    g = re.escape(g).replace(r"\*\*/", r"(.*/)?").replace(r"\*\*", r".*").replace(r"\*", r"[^/]*")
    return re.compile("^" + g + "$")


R_ = {k: [rx(g) for g in v["globs"]] for k, v in P.items()}
files = [f for f in subprocess.check_output(["git", "ls-files"], text=True).split("\n") if f]
cands = set(files)
for v in P.values():
    for g in v["globs"]:
        if "*" not in g:
            cands.add(g)
        else:
            cands.add(g.replace("**", "x/y").replace("*", "x"))
bad = 0
for f in sorted(cands):
    owners = [k for k, v in R_.items() if any(r.match(f) for r in v)]
    if len(owners) > 1:
        print("OVERLAP", f, owners)
        bad += 1
print("packages", len(P), "overlaps", bad)
