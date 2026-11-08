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

# npm auth. Publishing without a valid token fails with a bare
# "E404 Not Found - PUT https://registry.npmjs.org/<pkg>" — the registry hides
# "you are not allowed to publish this" behind a 404. Checking up front turns
# that into an explicit prompt before anything gets bumped.
npm_logged_in() {
    npm whoami >/dev/null 2>&1
}

ensure_npm_login() {
    local user
    if user=$(npm whoami 2>/dev/null); then
        echo "npm: logged in as $user"
        return 0
    fi

    echo "npm: not logged in (npm whoami failed) — publishing would fail with E404."
    read -p "Log in to npm now? (Y/n) " LOGIN_NOW
    if [[ -n "$LOGIN_NOW" && ! "$LOGIN_NOW" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo "Aborted — run 'npm login' first, then re-run this script."
        exit 1
    fi

    if ! npm login; then
        echo "npm login failed."
        exit 1
    fi

    if ! user=$(npm whoami 2>/dev/null); then
        echo "Still not logged in after 'npm login' — check ~/.npmrc and your token."
        exit 1
    fi
    echo "npm: logged in as $user"
}

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

# 0. Auth comes first: a broken token must never leave the repo bumped and
#    unpublished.
ensure_npm_login
echo ""

# 1. Read both published versions
MCP_VERSION=$(read_version mcp)
CLI_VERSION=$(read_version cli)

echo "Current versions:"
echo "  $MCP_PKG  $MCP_VERSION"
echo "  $CLI_PKG  $CLI_VERSION"

# 2. Detect a half-finished release
#    A partial publish leaves the two packages on different versions — or, when
#    the bump already happened locally, leaves one or both versions missing on
#    npm even though both package.json files agree. The fix is always the same:
#    publish what is missing at the current version, without bumping.
REPAIR_PKG=""
REPAIR_ALL=0
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
        # Bumped locally but nothing reached npm — the whole release has to
        # ship at the current version, not one patch further.
        echo "  Neither package has $BASE_VERSION on npm yet."
        REPAIR_ALL=1
        REPAIR_REASON="neither package has $BASE_VERSION on npm (release never landed)"
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
if [ "$REPAIR_ALL" -eq 1 ]; then
    echo "  $N) Publish $BASE_VERSION as-is (no version bump)"
    echo "       $REPAIR_REASON"
    N=$((N + 1))
    OFFSET=1
elif [ -n "$REPAIR_PKG" ]; then
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
if [ "$MODE" = "republish" ] && [ "$REPAIR_ALL" -eq 1 ]; then
    echo "You are about to PUBLISH $NEW_VERSION (both packages) — no version bump,"
    echo "the local versions are already at $NEW_VERSION."
elif [ "$MODE" = "republish" ]; then
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
if [ "$MODE" = "republish" ] && [ "$REPAIR_ALL" -eq 1 ]; then
    # Both workspaces are already on $NEW_VERSION — only publishing is missing.
    PUBLISH_TARGETS=("$MCP_PKG" "$CLI_PKG")
    echo ""
    echo "Local versions already at $NEW_VERSION — nothing to align."
elif [ "$MODE" = "republish" ]; then
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
    echo "Re-run this script — it detects what is still missing on npm and offers"
    echo "to publish it without bumping the version."
    echo "If the error was E404 on PUT, the npm user above cannot publish that"
    echo "package (wrong account or expired token) — check with 'npm whoami'."
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
    if [ $? -ne 0 ]; then
        echo "Push failed — no GitHub release created."
        echo "Once the push succeeds, create it with:"
        echo "  gh release create v$NEW_VERSION --title v$NEW_VERSION --generate-notes"
        exit 1
    fi

    # GitHub release. The tag is pushed right here, so "tag already exists" is
    # no evidence a release exists — the old tag-based workflow never fired.
    if ! command -v gh >/dev/null 2>&1; then
        echo "gh not installed — create the release manually:"
        echo "  gh release create v$NEW_VERSION --title v$NEW_VERSION --generate-notes"
    elif gh release view "v$NEW_VERSION" >/dev/null 2>&1; then
        echo "GitHub release v$NEW_VERSION already exists."
    else
        echo ""
        echo "Creating GitHub release v$NEW_VERSION..."
        if gh release create "v$NEW_VERSION" --title "v$NEW_VERSION" --generate-notes; then
            echo "Release: $(gh release view "v$NEW_VERSION" --json url --jq .url)"
        else
            echo "Failed to create the GitHub release. Retry with:"
            echo "  gh release create v$NEW_VERSION --title v$NEW_VERSION --generate-notes"
        fi
    fi
fi
