#!/bin/bash
set -e

# Publishable workspaces, in dependency order.
# NOTE: the repository root is `private: true` — publishing it would fail
# (and/or publish the wrong thing). Always target the workspaces explicitly.
WORKSPACES=("maven-indexer-cli" "maven-indexer-mcp")

# Function definitions
publish_npm() {
    echo "🚀 Publishing to npmjs.com..."
    for ws in "${WORKSPACES[@]}"; do
        echo "   📦 $ws"
        npm publish --workspace="$ws" --access public
    done
}

publish_github() {
    echo "🚀 Publishing to GitHub Packages..."

    # Check authentication before doing anything
    if ! npm whoami --registry=https://npm.pkg.github.com >/dev/null 2>&1; then
        echo "⚠️  You are not logged in to GitHub Packages."
        echo "� To publish, you need a GitHub Personal Access Token (classic) with:"
        echo "   ✅ write:packages"
        echo "   ✅ read:packages"
        echo ""
        echo "🔗 Create one here: https://github.com/settings/tokens/new?scopes=write:packages,read:packages&description=Maven%20Indexer%20MCP%20Publish"
        echo ""
        echo "📝 Instructions:"
        echo "   1. Click the link above to generate a token."
        echo "   2. Copy the generated token (it starts with 'ghp_')."
        echo "   3. When prompted below, use your GitHub username."
        echo "   4. For the 'Password', PASTE the token you just copied."
        echo ""
        read -p "Would you like to log in now? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "👉 Please enter your GitHub username and use your PAT as the password."
            if ! npm login --registry=https://npm.pkg.github.com; then
                echo "❌ Login failed. Please try again or login manually."
                exit 1
            fi
        else
            echo "❌ Authentication required. Please run 'npm login --registry=https://npm.pkg.github.com' and try again."
            exit 1
        fi
    fi
    
    # 1. Backup the workspace package.json files
    local LOCATIONS=()
    for ws in "${WORKSPACES[@]}"; do
        # Resolve the directory from the package name (mirrors the workspaces glob).
        loc=$(node -e "
        const fs = require('fs');
        for (const dir of fs.readdirSync('packages')) {
            const p = JSON.parse(fs.readFileSync('packages/' + dir + '/package.json', 'utf-8'));
            if (p.name === process.argv[1]) { console.log('packages/' + dir); break; }
        }
        " "$ws")
        [ -z "$loc" ] && { echo "❌ Cannot locate workspace $ws"; exit 1; }
        cp "$loc/package.json" "$loc/package.json.bak"
        LOCATIONS+=("$loc")
    done

    # 2. Update names to the scoped versions required by GitHub Packages
    for loc in "${LOCATIONS[@]}"; do
        node -e "
        const fs = require('fs');
        const file = process.argv[1] + '/package.json';
        const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
        pkg.name = '@tangcent/' + pkg.name;
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
        " "$loc"
    done
    
    # 3. Handle .npmrc for GitHub auth
    if [ -f .github/.npmrc ]; then
        cp .github/.npmrc .npmrc
    else
        echo "⚠️  Warning: .github/.npmrc not found! Publishing might fail if not authenticated."
    fi

    # Cleanup function
    cleanup() {
        rm -f .npmrc
        for loc in "${LOCATIONS[@]}"; do
            [ -f "$loc/package.json.bak" ] && mv "$loc/package.json.bak" "$loc/package.json"
        done
    }
    trap cleanup EXIT

    # 4. Publish
    for ws in "${WORKSPACES[@]}"; do
        echo "   📦 $ws"
        npm publish --workspace="$ws" --registry=https://npm.pkg.github.com
    done
    
    # Cleanup happens automatically via trap
    cleanup
    trap - EXIT
}

# Check if an argument was provided
TARGET=$1

# If no argument, prompt the user
if [ -z "$TARGET" ]; then
    echo "Select registry to publish to:"
    echo "1) All (GitHub & NPM)"
    echo "2) NPM only (npmjs.com)"
    echo "3) GitHub only (npm.pkg.github.com)"
    read -p "Enter choice [1-3]: " choice

    case $choice in
        1) TARGET="all" ;;
        2) TARGET="npm" ;;
        3) TARGET="github" ;;
        *) 
           echo "❌ Invalid choice"
           exit 1 
           ;;
    esac
fi

echo "👉 Selected target: $TARGET"

case $TARGET in
    npm)
        publish_npm
        ;;
    github)
        publish_github
        ;;
    all)
        echo "📦 Publishing to ALL registries..."
        
        # 1. GitHub
        if publish_github; then
            echo "✅ GitHub publish success."
        else
            echo "⚠️  GitHub publish failed (check if version already exists). Continuing..."
        fi
        
        # 2. NPM
        if publish_npm; then
             echo "✅ npm publish success."
        else
             echo "❌ npm publish failed."
             exit 1
        fi
        ;;
    *)
        echo "❌ Invalid option: $TARGET"
        echo "Usage: ./scripts/publish.sh [github|npm|all]"
        exit 1
        ;;
esac

echo "🎉 Done!"
