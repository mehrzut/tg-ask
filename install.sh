#!/usr/bin/env bash
# Installs tg-ask for Claude Code on this computer (macOS, Linux, or Git Bash on Windows).
#
#   ./install.sh --relay https://… --invite …   install and connect your Telegram
#   ./install.sh                                install only (connect later with tg-ask setup)
#
# Also works piped, without a clone:
#   curl -fsSL https://raw.githubusercontent.com/mehrzut/tg-ask/main/install.sh | bash -s -- --relay … --invite …
set -euo pipefail

# Files come from next to this script, or from GitHub when piped.
src="${TG_ASK_SRC:-https://raw.githubusercontent.com/mehrzut/tg-ask/main}"
here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
fetch() {
  if [ -n "$here" ] && [ -f "$here/$1" ]; then
    cp "$here/$1" "$2"
  else
    curl -fsSL "$src/$1" -o "$2"
  fi
}

bin="$HOME/.local/bin"
share="$HOME/.local/share/tg-ask"
claude="$HOME/.claude"

mkdir -p "$bin" "$share" "$claude"
fetch tg_ask.py "$share/tg_ask.py"

# A wrapper instead of a shebang: Windows has `python` or `py`, not always `python3`.
cat > "$bin/tg-ask" <<'EOF'
#!/usr/bin/env bash
for py in python3 python py; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
    exec "$py" -I "$HOME/.local/share/tg-ask/tg_ask.py" "$@"
  fi
done
echo "tg-ask: needs Python 3.8 or newer" >&2
exit 1
EOF
chmod +x "$bin/tg-ask"

# The instructions Claude follows, loaded into every session from your global CLAUDE.md.
fetch telegram-ask.md "$claude/telegram-ask.md"
import_line='@~/.claude/telegram-ask.md'
touch "$claude/CLAUDE.md"
if ! grep -qxF "$import_line" "$claude/CLAUDE.md"; then
  cat >> "$claude/CLAUDE.md" <<EOF

## Questions to the user

Ask every question in the session and on Telegram at once (\`tg-ask\`), and
continue with whichever answer arrives first.

$import_line
EOF
fi

echo "tg-ask installed."
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH (e.g. in ~/.zshrc or ~/.bashrc): export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

if [ $# -gt 0 ]; then
  "$bin/tg-ask" setup "$@"
else
  echo "Next: tg-ask setup --relay <URL> --invite <CODE>"
fi
