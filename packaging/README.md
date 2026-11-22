# Packaging

Installers, manifests and release automation for Burnrate. Everything here is a
draft until it has been run on a clean machine; **no script in this folder is
executed by the test suite**, and no signing material is stored in the repo.

- [checksums.mjs](scripts/checksums.mjs) - SHA256SUMS generator/verifier (`sha256sum -c` compatible).
- [render-manifests.mjs](scripts/render-manifests.mjs) - fills `__VERSION__`, `__REPO__`, `__DATE__` and `__SHA256_*__` in the manifests below.
- [validate-packaging.mjs](scripts/validate-packaging.mjs) - dependency-free lint for the workflows, manifests, NSIS script and PKGBUILD; also validates the YAML parser with `--self-test`.

## Release artifacts

The release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml))
publishes exactly these names. `SHA256SUMS` covers every binary artifact in the
same folder.

| Artifact | Built from |
| --- | --- |
| `Burnrate-<version>-windows-x64-setup.exe` | Tauri NSIS bundler with [tauri/bundle.conf.json](tauri/bundle.conf.json); fallback: [windows/burnrate.nsi](windows/burnrate.nsi) |
| `Burnrate-<version>-windows-x64.zip` | Portable zip (`burnrate.exe`, `burnrate-server.exe`, `web/`, `start.cmd`, `LICENSE`); Scoop source |
| `Burnrate-<version>-linux-x86_64.AppImage` | Tauri bundler (`appimage`) |
| `Burnrate-<version>-linux-amd64.deb` | Tauri bundler (`deb`) |
| `Burnrate-<version>-linux-x86_64.rpm` | Tauri bundler (`rpm`) |
| `Burnrate-<version>-linux-x86_64.tar.gz` | Staged tarball (desktop binary, server, `web/`, desktop file, icon, license); AUR + Flatpak source |
| `SHA256SUMS` (+ optional `SHA256SUMS.asc`) | [checksums.mjs](scripts/checksums.mjs), signed only when GPG secrets exist |

Rendered manifests are attached as extra release files:
`winget/Burnrate.Burnrate*.yaml`, `scoop/burnrate.json`, `aur/PKGBUILD`,
`flatpak/org.burnrate.Burnrate.yaml`.

## Windows

The primary installer is NSIS through the Tauri bundler. From `src-tauri/`:

```powershell
cargo tauri build --config ../packaging/tauri/bundle.conf.json --bundles nsis
```

The fragment targets a per-user install (`installMode: currentUser`), the
WebView2 bootstrapper (downloaded when missing, never bundled), English/German
UI, and the start-menu folder `Burnrate`. It intentionally does **not** set
`installerHooks` or certificate fields; signing is a separate opt-in config
(see [SIGNING.md](SIGNING.md)).

The standalone fallback (`makensis`, NSIS 3.x) is used when the desktop shell
has not been built. It installs the same per-user layout, registers the
`burnrate://` protocol, and keeps user data on uninstall:

```powershell
makensis /DPRODUCT_VERSION=0.1.0 /DPRODUCT_VERSION_QUAD=0.1.0.0 `
         /DSTAGE_DIR=C:\path\to\stage /DOUT_DIR=C:\path\to\out `
         packaging\windows\burnrate.nsi
```

`STAGE_DIR` must contain `burnrate.exe` (shell, optional), `burnrate-server.exe`,
`web\`, `start.cmd` and `LICENSE`.

- **winget**: [winget/](winget) holds the version, installer and `en-US` locale
  manifests. After a release, submit the three rendered files to
  `microsoft/winget-pkgs` under `manifests/b/Burnrate/Burnrate/<version>/`.
  `InstallerType: nullsoft`, `Scope: user`, silent switch `/S`.
- **Scoop**: [scoop/burnrate.json](scoop/burnrate.json) uses the portable zip and
  the `SHA256SUMS` autoupdate regex. Point a bucket at it (or submit to
  `ScoopInstaller/Extras`).
- The portable zip needs Microsoft Edge WebView2 (preinstalled on Windows 10/11)
  and is only published when the Tauri shell was built.

## Linux

[Tauri bundle fragment](tauri/bundle.conf.json) enables `appimage`, `deb` and
`rpm`, with `webkit2gtk-4.1`, GTK 3 and libayatana-appindicator dependencies.
Build on Ubuntu with the WebKitGTK dev packages installed:

```bash
cd src-tauri
cargo tauri build --config ../packaging/tauri/bundle.conf.json --bundles appimage,deb,rpm
```

The release job also stages a tarball with this layout (used by the AUR and
Flatpak drafts):

```
Burnrate-<version>-linux-x86_64/
  burnrate                     desktop shell (Tauri)
  burnrate-server              headless server (also used by the desktop shell)
  web/                         built web bundle
  org.burnrate.Burnrate.desktop
  org.burnrate.Burnrate.metainfo.xml
  org.burnrate.Burnrate.svg
  LICENSE
  README.md
```

- **Flatpak**: [flatpak/org.burnrate.Burnrate.yaml](flatpak/org.burnrate.Burnrate.yaml)
  is a **draft**. Open questions are listed at the top of the file (runtime
  WebKitGTK availability, sandbox access to `~/.claude` and `~/.codex`, tray on
  GNOME). It is not built by CI.
- **AUR**: [aur/PKGBUILD](aur/PKGBUILD) is a **draft** binary package
  (`burnrate-bin`) built from the Linux tarball. Before publishing: render it,
  run `bash -n PKGBUILD`, generate `.SRCINFO` with `makepkg --printsrcinfo`, and
  test in a clean chroot. Prerelease tags are not suitable for AUR (`pkgver`
  cannot contain `-`).

## Checksums and manifest rendering

```bash
# after the artifacts are collected in dist/release
node packaging/scripts/checksums.mjs dist/release             # writes dist/release/SHA256SUMS
node packaging/scripts/checksums.mjs --verify dist/release/SHA256SUMS

node packaging/scripts/render-manifests.mjs \
  --version 0.1.0 --repo owner/burnrate \
  --checksums dist/release/SHA256SUMS --out dist/manifests
```

Rendering fails when an artifact listed in `SHA256SUMS` is missing; pass
`--allow-missing` only for dry runs (writes zero hashes with a warning). The
checked-in templates are never modified.

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on pushes and pull
requests: web typecheck + vitest, `cargo test` on Windows and Ubuntu (CLI and
desktop shell are tested/checked when their crates exist), packaging lint, web
and release-server builds, then the size gate from `scripts/perf-budget.mjs`
when that file exists.

[.github/workflows/release.yml](../.github/workflows/release.yml) runs on `v*`
tags (or manual dispatch with a tag): builds the web bundle, server, Windows
installer + portable zip, Linux AppImage/deb/rpm + tarball, signs only if the
signing secrets are present, writes `SHA256SUMS`, renders the distro manifests,
and publishes a GitHub release.

## Local validation

```bash
node packaging/scripts/validate-packaging.mjs
node packaging/scripts/validate-packaging.mjs --self-test
node packaging/scripts/checksums.mjs --self-test
node packaging/scripts/render-manifests.mjs --self-test
```

`validate-packaging.mjs` is not a full YAML 1.2 implementation. It parses the
subset used here (block/compact mappings and sequences, flow lists, block
scalars, comments) and fails on tabs, duplicate keys, bad indentation,
unbalanced quotes/collections, unknown release tokens, broken workflow shapes,
malformed winget/Scoop/Flatpak manifests, unbalanced NSIS sections and a
PKGBUILD without `package()`.

## Not verified here

- No installer, Flatpak, `makepkg`, winget submission or signing command has
  been run as part of this package. CI builds the web bundle and the server, and
  a tag release additionally requires the desktop shell (work package 12) for
  the Linux bundles and the Windows installer.
- Linux `.desktop`/AppStream metadata and the Flatpak sandbox permissions need a
  real desktop test (GNOME and KDE), including tray availability.
- NSIS language selection, protocol registration and the WebView2 bootstrapper
  need a clean Windows VM without WebView2 installed.
- Icon files under `src-tauri/icons/` are owned by the desktop shell package;
  the bundler config expects them to exist.
