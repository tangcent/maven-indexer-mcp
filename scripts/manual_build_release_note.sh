#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Navigate to project root
cd "$PROJECT_ROOT" || exit 1

# Get the current version from package.json
CURRENT_VERSION="v$(node -p "require('./package.json').version")"

# Get the previous tag
PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "v0.0.0")

echo "Generating release notes for $CURRENT_VERSION (Previous: $PREV_TAG)"
echo "----------------------------------------------------------------"

# Generate the release notes
NOTES="**Full Changelog**: https://github.com/tangcent/maven-indexer-mcp/compare/${PREV_TAG}...${CURRENT_VERSION}\n\n"

# Add commit messages since last tag
COMMITS=$(git log --pretty=format:"* %s" $PREV_TAG..HEAD | grep -E '^\* (refactor|feat|fix)')

if [ -z "$COMMITS" ]; then
    COMMITS="No major changes (refactor, feat, fix) found."
fi

NOTES="${NOTES}${COMMITS}\n\n"

# Output the notes
echo -e "$NOTES"
