#!/usr/bin/env bash
# Installs maven-indexer-cli (npm, global) and the maven-indexer Agent Skill.
#
#   curl -fsSL https://raw.githubusercontent.com/tangcent/maven-indexer-mcp/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/tangcent/maven-indexer-mcp/main/install.sh | bash -s -- --target claude,agents
#
# Run with --help for options.

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/tangcent/maven-indexer-mcp"
SKILL_NAME="maven-indexer"

VERSION="latest"
TARGET="auto"
LOCATION="global"
SKILLS_DIR=""
SKIP_CLI=0
SKIP_SKILLS=0
BUILD_INDEX=0
REF="${MAVEN_INDEXER_REF:-main}"

usage() {
  cat <<'EOF'
Install maven-indexer-cli and the maven-indexer Agent Skill.

Usage: install.sh [options]

Options:
  --version <v>       maven-indexer-cli version to install from npm (default: latest)
  --target <t>        Where to install the skill: auto (detected agents, default), all,
                      or a csv of: claude, agents, cursor
                        claude  -> ~/.claude/skills
                        agents  -> ~/.agents/skills (Codex, Gemini CLI, OpenCode, ...)
                        cursor  -> ~/.cursor/skills
  --location <l>      global (home directory, default) or local (current directory)
  --dir <path>        Install the skill into this skills directory instead of --target
  --skip-cli          Do not install maven-indexer-cli (skill only)
  --skip-skills       Do not install the skill (CLI only)
  --index             Build the local Maven/Gradle index after installing
  -h, --help          Show this help

Environment:
  MAVEN_INDEXER_REF   Git ref used when the skill has to be downloaded (default: main)
EOF
}

need_arg() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    echo "error: $1 needs a value" >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_arg "$@"; VERSION="$2"; shift 2 ;;
    --target) need_arg "$@"; TARGET="$2"; shift 2 ;;
    --location) need_arg "$@"; LOCATION="$2"; shift 2 ;;
    --dir) need_arg "$@"; SKILLS_DIR="$2"; shift 2 ;;
    --skip-cli) SKIP_CLI=1; shift ;;
    --skip-skills) SKIP_SKILLS=1; shift ;;
    --index) BUILD_INDEX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option '$1' (see --help)" >&2; exit 2 ;;
  esac
done

case "$LOCATION" in
  global|local) ;;
  *) echo "error: --location must be 'global' or 'local'" >&2; exit 2 ;;
esac

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

CLI=""

# Locates the maven-indexer-cli binary: PATH first, then npm's global bin dir
# (which is not always on PATH, e.g. with a custom npm prefix).
find_cli() {
  if command -v maven-indexer-cli >/dev/null 2>&1; then
    CLI="$(command -v maven-indexer-cli)"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    local prefix
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$prefix" ] && [ -x "$prefix/bin/maven-indexer-cli" ]; then
      CLI="$prefix/bin/maven-indexer-cli"
      return 0
    fi
  fi
  return 1
}

install_cli() {
  command -v node >/dev/null 2>&1 || die "Node.js 18+ is required: https://nodejs.org/"
  command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node.js 18+ is required (found $(node --version))."

  info "Installing maven-indexer-cli@$VERSION (npm install -g)"
  if ! npm install -g "maven-indexer-cli@$VERSION"; then
    die "npm install -g failed. If it is a permissions error, set a user-writable npm prefix
       (npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH) and re-run."
  fi
  find_cli || die "maven-indexer-cli was installed but cannot be found; add \"$(npm prefix -g)/bin\" to PATH."
  info "Installed $("$CLI" --version 2>/dev/null || echo '?') at $CLI"
  case ":$PATH:" in
    *":$(dirname "$CLI"):"*) ;;
    *) warn "$(dirname "$CLI") is not on PATH; add it so agents can run maven-indexer-cli." ;;
  esac
}

# Fallback for CLI versions without `skills install` (or --skip-cli without a CLI):
# download SKILL.md from GitHub into the same directories the CLI would use.
skill_dirs_fallback() {
  if [ -n "$SKILLS_DIR" ]; then
    echo "$SKILLS_DIR"
    return
  fi
  local base="$HOME"
  [ "$LOCATION" = "local" ] && base="."
  local targets="$TARGET" found=""
  if [ "$targets" = "all" ]; then
    targets="claude,agents,cursor"
  elif [ "$targets" = "auto" ]; then
    [ -d "$base/.claude" ] && found="$found,claude"
    { [ -d "$base/.agents" ] || [ -d "$base/.codex" ] || [ -d "$base/.gemini" ] || [ -d "$base/.config/opencode" ]; } && found="$found,agents"
    [ -d "$base/.cursor" ] && found="$found,cursor"
    targets="${found#,}"
    [ -n "$targets" ] || targets="claude"
  fi
  local t
  for t in ${targets//,/ }; do
    case "$t" in
      claude) echo "$base/.claude/skills" ;;
      agents) echo "$base/.agents/skills" ;;
      cursor) echo "$base/.cursor/skills" ;;
      *) warn "unknown target '$t', skipping" ;;
    esac
  done
}

install_skill_fallback() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download the skill."
  local tmp url dir dest
  tmp="$(mktemp)"
  url="$REPO_RAW/$REF/skills/$SKILL_NAME/SKILL.md"
  info "Downloading skill from $url"
  curl -fsSL "$url" -o "$tmp" || { rm -f "$tmp"; die "could not download $url"; }
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    dest="$dir/$SKILL_NAME"
    if [ -f "$dest/SKILL.md" ] && ! grep -Eq "^name:[[:space:]]*$SKILL_NAME[[:space:]]*$" "$dest/SKILL.md"; then
      warn "$dest holds a different skill; skipping"
      continue
    fi
    mkdir -p "$dest"
    cp "$tmp" "$dest/SKILL.md"
    info "Installed skill: $dest/SKILL.md"
  done < <(skill_dirs_fallback)
  rm -f "$tmp"
}

install_skill() {
  # Older CLIs print the root help (exit 0) for an unknown subcommand's --help,
  # so look for `skills` in the command list instead of trusting the exit code.
  if [ -n "$CLI" ] && "$CLI" --help 2>/dev/null | grep -Eq '^[[:space:]]+skills[[:space:]]'; then
    info "Installing the $SKILL_NAME skill (maven-indexer-cli skills install)"
    if [ -n "$SKILLS_DIR" ]; then
      "$CLI" skills install --dir "$SKILLS_DIR"
    else
      "$CLI" skills install --target "$TARGET" --location "$LOCATION"
    fi
  else
    [ -n "$CLI" ] && info "This maven-indexer-cli has no 'skills' command; downloading the skill instead"
    install_skill_fallback
  fi
}

if [ "$SKIP_CLI" -eq 0 ]; then
  install_cli
else
  find_cli || true
fi

if [ "$SKIP_SKILLS" -eq 0 ]; then
  install_skill
fi

if [ "$BUILD_INDEX" -eq 1 ]; then
  [ -n "$CLI" ] || die "--index needs maven-indexer-cli (drop --skip-cli or install it first)."
  info "Building the index (maven-indexer-cli refresh-index); this can take a few minutes"
  "$CLI" refresh-index
fi

echo
info "Done."
if [ "$BUILD_INDEX" -eq 0 ] && [ -n "$CLI" ]; then
  echo "    Build the index once with:  maven-indexer-cli refresh-index"
fi
echo "    Restart your coding agent (or start a new session) so it loads the skill."
