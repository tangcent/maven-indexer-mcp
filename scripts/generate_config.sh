#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Assuming the script is in /scripts, the project root is one level up
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_PATH="$PROJECT_ROOT/build/index.js"
CFR_PATH="$PROJECT_ROOT/lib/cfr-0.152.jar"

# Function to check if a command exists
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "Warning: '$1' is not installed or not in your PATH."
        return 1
    fi
    return 0
}

echo "Checking environment..."

# Check for required tools
MISSING_TOOLS=0
check_command "node" || MISSING_TOOLS=1
check_command "npm" || MISSING_TOOLS=1
check_command "java" || MISSING_TOOLS=1

if [ $MISSING_TOOLS -eq 1 ]; then
    echo "Some required tools are missing. The server might not work correctly."
    read -p "Continue anyway? (Y/n) " response
    if [[ ! -z "$response" && ! "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        exit 1
    fi
fi

# Check for node_modules
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo "Dependencies not found (node_modules missing)."
    read -p "Do you want to run 'npm install'? (Y/n) " response
    if [[ -z "$response" || "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        cd "$PROJECT_ROOT" && npm install
        if [ $? -ne 0 ]; then
            echo "npm install failed."
            exit 1
        fi
    else
        echo "Dependencies are required. Exiting."
        exit 1
    fi
fi

# Check for build artifact
if [ ! -f "$BUILD_PATH" ]; then
    echo "Build artifact not found ($BUILD_PATH)."
    read -p "Do you want to run 'npm run build'? (Y/n) " response
    if [[ -z "$response" || "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        cd "$PROJECT_ROOT" && npm run build
        if [ $? -ne 0 ]; then
            echo "Build failed."
            exit 1
        fi
    else
        echo "Build artifact is required. Exiting."
        exit 1
    fi
fi

echo "Environment check passed."
echo ""

echo "=== Simple Configuration ==="
cat <<EOF
{
  "mcpServers": {
    "maven-indexer-local": {
      "command": "node",
      "args": ["$BUILD_PATH"]
    }
  }
}
EOF

echo ""
echo "=== Full Environment Configuration ==="
cat <<EOF
{
  "mcpServers": {
    "maven-indexer-local": {
      "command": "node",
      "args": ["$BUILD_PATH"],
      "env": {
        "MAVEN_REPO": "/path/to/maven/repo",
        "JAVA_HOME": "/path/to/java/home",
        "INCLUDED_PACKAGES": "com.example.*,org.test.*",
        "MAVEN_INDEXER_CFR_PATH": "$CFR_PATH"
      }
    }
  }
}
EOF
