# Signing

**Releases are unsigned by default.** No certificate, key or password is stored
in this repository or baked into an artifact. The release workflow only signs
when the corresponding repository secret is configured; otherwise it publishes
the plain binaries, `SHA256SUMS`, and tells users how to verify.

`packaging/tauri/signing.example.json` contains placeholders only. Never commit
a real certificate, PFX, private key or password. Secret names below are
referenced by the workflow as `${{ secrets.NAME }}` and are never echoed.

## Windows (Authenticode)

Unsigned installers trigger SmartScreen ("Windows protected your PC"). Signing
is optional but recommended for public releases.

1. Obtain a code-signing certificate (OV/EV) as a `.pfx`.
2. Add two repository secrets:
   - `WINDOWS_CERT_PFX_BASE64` - the `.pfx` file, base64 encoded:
     ```powershell
     [Convert]::ToBase64String([IO.File]::ReadAllBytes("burnrate.pfx"))
     ```
   - `WINDOWS_CERT_PASSWORD` - the `.pfx` password.
3. When both secrets exist, the release job imports the PFX into
   `Cert:\CurrentUser\My` and signs every `out/*.exe` with `signtool`
   (SHA-256, DigiCert timestamp). If `signtool.exe` is missing the job fails
   loudly instead of shipping a half-signed release.
4. To sign through the Tauri bundler instead, render the thumbprint into a copy
   of `tauri/signing.example.json` at build time and pass it as a second
   `--config`. Do not commit that rendered file.

The installer itself is per-user (`currentUser`) and never requests elevation,
so no elevation prompt is involved in installation.

## Linux (GPG detached signatures)

Two optional secrets:

- `GPG_PRIVATE_KEY` - ASCII-armored private key (`gpg --armor --export-secret-keys <key-id>`).
- `GPG_PASSPHRASE` - its passphrase (empty for a passphrase-less CI key).

When `GPG_PRIVATE_KEY` is set, the release job signs `SHA256SUMS` and every
artifact with `--armor --detach-sign`, producing `*.asc` files next to each
release file. Verify with:

```bash
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c SHA256SUMS
```

The AUR `PKGBUILD` uses the tarball hash; distributions that verify GPG should
check `Burnrate-<version>-linux-x86_64.tar.gz.asc` against the published key.

## Tauri updater keys (not used yet)

Burnrate's update check (`GET /api/update-check`) reads GitHub releases; it does
not run the Tauri updater. If updater artifacts are enabled later, use
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository
secrets and set `bundle.createUpdaterArtifacts` in a separate untracked config.
Do not mix updater keys with the historical WASM "signing" key names.

## Verification for users

```bash
# Windows (PowerShell)
Get-FileHash .\Burnrate-0.1.0-windows-x64-setup.exe -Algorithm SHA256
# compare with SHA256SUMS

# Linux
sha256sum -c SHA256SUMS
```

## What is never done here

- No secret is written to a file that is uploaded.
- No installer, `makepkg`, Flatpak build or signing command runs in this
  worktree or in the test suite.
- The repository-scoped `GITHUB_TOKEN` is used only to create the release; the
  workflow requests `contents: write` and nothing else.
