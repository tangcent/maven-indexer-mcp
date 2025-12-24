#!/bin/bash
set -e

# Function definitions
publish_npm() {
    echo "🚀 Publishing to npmjs.com..."
    # Defaults to public npm registry with package name "maven-indexer-mcp"
    npm publish --access public
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
    
    # 1. Backup package.json
    cp package.json package.json.bak
    
    # 2. Update name to scoped version for GitHub
    # We use a temp node script to reliably update the JSON
    node -e "
    const fs = require('fs');
    const pkg = require('./package.json');
    pkg.name = '@tangcent/maven-indexer-mcp';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
    "
    
    # 3. Handle .npmrc for GitHub auth
    if [ -f .github/.npmrc ]; then
        cp .github/.npmrc .npmrc
    else
        echo "⚠️  Warning: .github/.npmrc not found! Publishing might fail if not authenticated."
    fi

    # Cleanup function
    cleanup() {
        rm -f .npmrc
        mv package.json.bak package.json
    }
    trap cleanup EXIT

    # 4. Publish
    npm publish --registry=https://npm.pkg.github.com
    
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
