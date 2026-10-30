#!/usr/bin/env bash
# keyboard-heart installer: deps → doctor → optional service registration
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1;32m✔\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "Node.js 20+ required: https://nodejs.org"

say "installing dependencies…"
npm install --no-fund --no-audit 2>/dev/null || npm install

say "probing for keyboard…"
node bin/kbctl.js doctor

case "${1:-}" in
  --launchd)
    [ "$(uname)" = "Darwin" ] || die "--launchd is macOS only (use --systemd on Linux)"
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/com.keyboard-heart.plist"
    mkdir -p "$PLIST_DIR"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.keyboard-heart</string>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$PWD/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/keyboard-heart.log</string>
  <key>StandardErrorPath</key><string>/tmp/keyboard-heart.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    say "launchd service registered — starts at login, restarts on crash (log: /tmp/keyboard-heart.log)"
    ;;
  --systemd)
    command -v systemctl >/dev/null || die "systemctl not found"
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/keyboard-heart.service" <<EOF
[Unit]
Description=keyboard-heart RGB notification service

[Service]
WorkingDirectory=$PWD
ExecStart=$(command -v node) server.js
Restart=always

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now keyboard-heart.service
    say "systemd user service registered"
    ;;
  "")
    say "done. start the service with: npm start"
    say "register autostart with:      ./install.sh --launchd   (macOS)"
    say "                              ./install.sh --systemd   (Linux)"
    ;;
  *) die "unknown option: $1 (supported: --launchd, --systemd)" ;;
esac
