#!/bin/sh
# Register the burnrate:// handler declared by the desktop file's MimeType.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true
fi
exit 0
