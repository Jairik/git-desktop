#!/usr/bin/env bash
# Link the built app onto PATH and register a desktop entry so app launchers
# can find it and so the browser can hand OAuth sign-in callbacks back to it.
# Run `yarn build:prod` (or `yarn build:dev`) first, or use `yarn install:local`
# which does both. Pass --uninstall to remove them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_NAME="git-desktop"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$APP_DIR/$BIN_NAME.desktop"
EXECUTABLE="$ROOT/dist/desktop-linux-x64/desktop"
ICON="$ROOT/app/static/linux/icon-logo.png"
# x-github-client: "Open in Desktop" links. The auth schemes carry the OAuth
# callback (dev builds, and builds without a custom OAuth secret, use -dev-auth).
PROTOCOLS=(x-github-client x-github-desktop-auth x-github-desktop-dev-auth)

MIME_TYPES=""
for protocol in "${PROTOCOLS[@]}"; do
  MIME_TYPES+="x-scheme-handler/$protocol;"
done

refresh_desktop_database() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$BIN_DIR/$BIN_NAME" "$DESKTOP_FILE"
  refresh_desktop_database
  echo "Removed $BIN_DIR/$BIN_NAME and $DESKTOP_FILE"
  exit 0
fi

if [[ ! -x "$EXECUTABLE" ]]; then
  echo "No build found at $EXECUTABLE. Run 'yarn build:prod' first." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR"
ln -sf "$EXECUTABLE" "$BIN_DIR/$BIN_NAME"

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Git Desktop (fork)
Comment=GitHub Desktop fork
Exec=$EXECUTABLE %U
Icon=$ICON
Type=Application
Terminal=false
Categories=Development;RevisionControl;
StartupWMClass=GitHub Desktop
MimeType=$MIME_TYPES
EOF

refresh_desktop_database

if command -v xdg-mime >/dev/null 2>&1; then
  for protocol in "${PROTOCOLS[@]}"; do
    xdg-mime default "$BIN_NAME.desktop" "x-scheme-handler/$protocol"
  done
else
  echo "Note: xdg-mime not found; sign-in links won't open the app." >&2
fi

echo "Linked $BIN_DIR/$BIN_NAME -> $EXECUTABLE"
echo "Wrote $DESKTOP_FILE"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH." ;;
esac
