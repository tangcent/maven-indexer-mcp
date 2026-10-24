#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Navigate to project root
cd "$PROJECT_ROOT" || exit 1

# The two packages that actually reach npm. packages/engine is private — it is
# inlined into each bundle by scripts/bundle-package.mjs.
MCP_PKG="maven-indexer-mcp"
CLI_PKG="maven-indexer-cli"

read_version() {
    node -p "require('./packages/$1/package.json').version"
}

# Prints 1 / 0 / -1. Any pre-release suffix (1.2.0-beta.1) is ignored — this
# script only reasons about the X.Y.Z core.
version_compare() {
    node -e '
const parse = (v) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
const a = parse(process.argv[1]);
const b = parse(process.argv[2]);
const cmp = (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
console.log(cmp > 0 ? 1 : cmp < 0 ? -1 : 0);
' "$1" "$2"
}

# 0 = this exact version is on the registry
# 1 = definitely not published (E404)
# 2 = could not tell (network, auth, registry trouble)
npm_has_version() {
    local out
    out=$(npm view "$1@$2" version 2>&1)
    if [ $? -eq 0 ] && [ -n "$out" ]; then
        return 0
    fi
    if echo "$out" | grep -qE "E404|404 Not Found"; then
        return 1
    fi
    return 2
}

# 1. Read both published versions
MCP_VERSION=$(read_version mcp)
CLI_VERSION=$(read_version cli)

echo "Current versions:"
echo "  $MCP_PKG  $MCP_VERSION"
echo "  $CLI_PKG  $CLI_VERSION"

# 2. Detect a half-finished release
#    A partial publish leaves the two packages on different versions — or, when
#    the bump already happened locally, leaves one version missing on npm even
#    though both package.json files agree. Either way the fix is the same:
#    republish the lagging package at the higher version, without bumping.
REPAIR_PKG=""
REPAIR_REASON=""

case "$(version_compare "$MCP_VERSION" "$CLI_VERSION")" in
    1)
        REPAIR_PKG="$CLI_PKG"
        REPAIR_REASON="$CLI_PKG $CLI_VERSION is behind $MCP_PKG $MCP_VERSION"
        BASE_VERSION="$MCP_VERSION"
        ;;
    -1)
        REPAIR_PKG="$MCP_PKG"
        REPAIR_REASON="$MCP_PKG $MCP_VERSION is behind $CLI_PKG $CLI_VERSION"
        BASE_VERSION="$CLI_VERSION"
        ;;
    *)
        BASE_VERSION="$MCP_VERSION"
        ;;
esac

if [ -z "$REPAIR_PKG" ]; then
    echo ""
    echo "Both packages agree on $BASE_VERSION — checking the npm registry..."
    npm_has_version "$MCP_PKG" "$BASE_VERSION"; MCP_ON_NPM=$?
    npm_has_version "$CLI_PKG" "$BASE_VERSION"; CLI_ON_NPM=$?

    if [ "$MCP_ON_NPM" -eq 0 ] && [ "$CLI_ON_NPM" -eq 1 ]; then
        REPAIR_PKG="$CLI_PKG"
        REPAIR_REASON="$CLI_PKG@$BASE_VERSION is missing from npm (partial publish)"
    elif [ "$MCP_ON_NPM" -eq 1 ] && [ "$CLI_ON_NPM" -eq 0 ]; then
        REPAIR_PKG="$MCP_PKG"
        REPAIR_REASON="$MCP_PKG@$BASE_VERSION is missing from npm (partial publish)"
    elif [ "$MCP_ON_NPM" -eq 2 ] || [ "$CLI_ON_NPM" -eq 2 ]; then
        echo "  Registry check inconclusive — republish option disabled."
    elif [ "$MCP_ON_NPM" -eq 1 ] && [ "$CLI_ON_NPM" -eq 1 ]; then
        echo "  Neither package has $BASE_VERSION on npm yet."
    else
        echo "  Both present on npm."
    fi
fi

# 3. Calculate candidate versions from the base (higher) version
read -r MAJOR MINOR PATCH <<< "$(node -p "
const v = '$BASE_VERSION'.split('-')[0].split('.');
[(parseInt(v[0], 10) || 0), (parseInt(v[1], 10) || 0), (parseInt(v[2], 10) || 0)].join(' ')
")"

NEXT_PATCH="$MAJOR.$MINOR.$((PATCH + 1))"
NEXT_MINOR="$MAJOR.$((MINOR + 1)).0"
NEXT_MAJOR="$((MAJOR + 1)).0.0"

# 4. Menu — the republish option, when offered, takes slot 1 and shifts the rest
echo ""
echo "Select a new version to release:"
N=1
if [ -n "$REPAIR_PKG" ]; then
    echo "  $N) Republish $REPAIR_PKG@$BASE_VERSION (no version bump)"
    echo "       $REPAIR_REASON"
    N=$((N + 1))
    OFFSET=1
else
    OFFSET=0
fi
echo "  $N) Patch  ($NEXT_PATCH)"; N=$((N + 1))
echo "  $N) Minor  ($NEXT_MINOR)"; N=$((N + 1))
echo "  $N) Major  ($NEXT_MAJOR)"; N=$((N + 1))
echo "  $N) Custom"; N=$((N + 1))
echo "  $N) Cancel"
MAX_CHOICE=$N

read -p "Enter your choice [1-$MAX_CHOICE]: " CHOICE

case "$CHOICE" in
    ''|*[!0-9]*)
        echo "Invalid choice."
        exit 1
        ;;
esac

if [ "$CHOICE" -lt 1 ] || [ "$CHOICE" -gt "$MAX_CHOICE" ]; then
    echo "Invalid choice."
    exit 1
fi

NEW_VERSION=""
MODE="release"

if [ "$OFFSET" -eq 1 ] && [ "$CHOICE" -eq 1 ]; then
    MODE="republish"
    NEW_VERSION="$BASE_VERSION"
else
    # Shift the choice back into the plain patch/minor/major/custom/cancel slots
    case $((CHOICE - OFFSET)) in
        1) NEW_VERSION="$NEXT_PATCH" ;;
        2) NEW_VERSION="$NEXT_MINOR" ;;
        3) NEW_VERSION="$NEXT_MAJOR" ;;
        4)
            read -p "Enter custom version: " NEW_VERSION
            if [ -z "$NEW_VERSION" ]; then
                echo "Version cannot be empty."
                exit 1
            fi
            ;;
        5)
            echo "Release cancelled."
            exit 0
            ;;
    esac
fi

echo ""
if [ "$MODE" = "republish" ]; then
    echo "You are about to REPUBLISH $REPAIR_PKG@$NEW_VERSION — no version bump,"
    echo "no other package is touched."
else
    echo "You are about to release version: $NEW_VERSION"
fi
read -p "Are you sure? (y/N) " CONFIRM
if [[ ! "$CONFIRM" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Cancelled."
    exit 0
fi

# 5. Apply the version change
if [ "$MODE" = "republish" ]; then
    PUBLISH_TARGETS=("$REPAIR_PKG")
    echo ""
    echo "Aligning $REPAIR_PKG to $NEW_VERSION..."
    # Only this workspace moves — the other one is already published at that
    # version and republishing it would fail with EPUBLISHCONFLICT.
    npm pkg set "version=$NEW_VERSION" --workspace="$REPAIR_PKG"
    if [ $? -ne 0 ]; then
        echo "Error updating version."
        exit 1
    fi
else
    PUBLISH_TARGETS=("$MCP_PKG" "$CLI_PKG")
    echo ""
    echo "Updating version to $NEW_VERSION..."
    # Keep every workspace (and the root) on the same version — the monorepo is
    # released as one unit, and the bundled packages advertise this number.
    if ! npm version "$NEW_VERSION" --workspaces --include-workspace-root --git-tag-version=false; then
        echo "Error updating version."
        # npm version rewrites each workspace in turn, so a mid-way failure
        # leaves package.json bumped and package-lock.json stale. Say so instead
        # of leaving the user to discover it.
        echo "package.json files may already be changed — inspect with:"
        echo "  git diff --stat package.json package-lock.json packages/*/package.json"
        exit 1
    fi
fi

# 6. Build (prepublishOnly would do it too, but failing here is cheaper)
echo ""
echo "Building project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed. Aborting release."
    exit 1
fi

# 7. Publish, in dependency order. A failure stops the loop so the second
#    package never lands on a version the first one failed to publish.
echo ""
echo "Publishing to npm..."
PUBLISH_RC=0
for ws in "${PUBLISH_TARGETS[@]}"; do
    echo "   $ws"
    if ! npm publish --workspace="$ws" --access public; then
        PUBLISH_RC=1
        break
    fi
done

if [ "$PUBLISH_RC" -ne 0 ]; then
    echo ""
    echo "Publish failed."
    echo "Re-run this script — the republish option will pick up the gap."
    exit 1
fi

echo ""
echo "Successfully published $NEW_VERSION: ${PUBLISH_TARGETS[*]}"

# 8. Optional: git commit + tag
read -p "Do you want to commit, tag and push? (y/N) " GIT_TAG
if [[ "$GIT_TAG" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    git add package.json package-lock.json packages/*/package.json
    if git diff --cached --quiet; then
        echo "Nothing to commit — versions already match HEAD."
    else
        git commit -m "chore(release): $NEW_VERSION"
    fi

    if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
        echo "Tag v$NEW_VERSION already exists — skipping tag creation."
    else
        git tag "v$NEW_VERSION"
    fi

    git push && git push --tags
fi
