#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Navigate to project root
cd "$PROJECT_ROOT" || exit 1

# 1. Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# 2. Calculate candidate versions
# Split version into parts (Assuming Semantic Versioning X.Y.Z)
IFS='.' read -r -a VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"

# Handle cases where version might include pre-release tags (e.g., 1.0.0-beta.1)
# For simplicity, this script focuses on standard X.Y.Z increments. 
# If complex semver parsing is needed, we might need a more robust node script.
# Basic cleaning to ensure they are numbers
MAJOR=$(echo "$MAJOR" | grep -oE '^[0-9]+')
MINOR=$(echo "$MINOR" | grep -oE '^[0-9]+')
PATCH=$(echo "$PATCH" | grep -oE '^[0-9]+')

NEXT_PATCH="$MAJOR.$MINOR.$((PATCH + 1))"
NEXT_MINOR="$MAJOR.$((MINOR + 1)).0"
NEXT_MAJOR="$((MAJOR + 1)).0.0"

echo ""
echo "Select a new version to release:"
echo "1) Patch ($NEXT_PATCH)"
echo "2) Minor ($NEXT_MINOR)"
echo "3) Major ($NEXT_MAJOR)"
echo "4) Custom"
echo "5) Cancel"

read -p "Enter your choice [1-5]: " CHOICE

NEW_VERSION=""

case $CHOICE in
    1)
        NEW_VERSION="$NEXT_PATCH"
        ;;
    2)
        NEW_VERSION="$NEXT_MINOR"
        ;;
    3)
        NEW_VERSION="$NEXT_MAJOR"
        ;;
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
    *)
        echo "Invalid choice."
        exit 1
        ;;
esac

echo ""
echo "You are about to release version: $NEW_VERSION"
read -p "Are you sure? (y/N) " CONFIRM
if [[ ! "$CONFIRM" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    echo "Cancelled."
    exit 0
fi

# 3. Update version
echo ""
echo "Updating version to $NEW_VERSION..."
npm version "$NEW_VERSION" --git-tag-version=false
if [ $? -ne 0 ]; then
    echo "Error updating version."
    exit 1
fi

# 4. Build (handled by prepublishOnly, but good to check explicitly or let npm publish handle it)
# The user asked to try build candidate versions. 
# Since npm publish runs prepublishOnly -> npm run build, it is covered.
# But we can run it explicitly to be safe before publishing.

echo "Building project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed. Aborting release."
    # Revert version change? It's modified package.json.
    # We could git checkout package.json, but user might have other changes.
    # Leaving it for user to fix.
    exit 1
fi

# 5. Publish
echo ""
echo "Publishing to npm..."
# Using --dry-run for now to prevent accidental publish during development/testing of this script
# remove --dry-run for actual usage
# read -p "Perform actual publish? (y/N - 'n' will do dry-run) " DO_PUBLISH
# if [[ "$DO_PUBLISH" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    npm publish
# else
#     npm publish --dry-run
# fi

if [ $? -eq 0 ]; then
    echo ""
    echo "Successfully published version $NEW_VERSION!"
    
    # Optional: Git tag
    read -p "Do you want to create a git tag and push? (y/N) " GIT_TAG
    if [[ "$GIT_TAG" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        git add package.json package-lock.json
        git commit -m "chore(release): $NEW_VERSION"
        git tag "v$NEW_VERSION"
        git push && git push --tags
    fi
else
    echo "Publish failed."
    exit 1
fi
