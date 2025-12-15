# Development and Publication Guide

This guide covers how to test the Maven Indexer MCP Server locally during development and how to publish it to the NPM registry.

## Local Development & Testing

### 1. Building the Project

The project uses TypeScript, so you need to compile it before running:

```bash
npm install
npm run build
```

To watch for changes during development:

```bash
npm run watch
```

### 2. Running Tests

We use Vitest for testing. Run the test suite with:

```bash
npm test
```

### 3. Testing the MCP Server Locally

There are two main ways to test the server with an MCP client (like Claude Desktop) before publishing.

#### Option A: Use Absolute Path (Recommended for active dev)

Configure your MCP client to point directly to the built file. This allows you to see changes immediately after rebuilding.

```json
{
  "mcpServers": {
    "maven-indexer-local": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/maven-indexer/build/index.js"],
      "env": {
        "MAVEN_REPO": "/path/to/test/repo", // Optional: Override for testing
        "GRADLE_REPO_PATH": "/path/to/test/gradle-repo" // Optional: Override for testing
      }
    }
  }
}
```

#### Option B: `npm link` (Simulate global install)

1.  In the project root, run:
    ```bash
    npm link
    ```
2.  This registers `maven-indexer-mcp` globally on your machine.
3.  Configure your MCP client:
    ```json
    {
      "mcpServers": {
        "maven-indexer-link": {
          "command": "maven-indexer-mcp",
          "args": []
        }
      }
    }
    ```

### 4. Verify Local Packaging

Before publishing, it's good practice to verify what files will be included in the package.

1.  Run `npm pack`. This creates a `.tgz` file (e.g., `maven-indexer-mcp-1.0.0.tgz`).
2.  Inspect the contents of the tarball to ensure `build/`, `README.md`, and `LICENSE` are included and extraneous files are excluded.

## Publishing to NPM

### Prerequisites

1.  An account on [npmjs.com](https://www.npmjs.com/).
2.  Login to npm via terminal:
    ```bash
    npm login
    ```

### Publishing Steps

1.  **Update Version**: If you have made changes, update the version number in `package.json`. You can use the npm version command:
    ```bash
    npm version patch  # 1.0.0 -> 1.0.1
    npm version minor  # 1.0.0 -> 1.1.0
    npm version major  # 1.0.0 -> 2.0.0
    ```

2.  **Build and Publish**:
    The `prepublishOnly` script in `package.json` will automatically run `npm run build` before publishing.

    ```bash
    npm publish
    ```
    
    *Note: If this is the first time publishing a scoped package (e.g. `@username/package`), you might need to add `--access public`.*

3.  **Verification**:
    *   Check the package page on npmjs.com.
    *   Try running it via `npx`:
        ```bash
        npx maven-indexer-mcp@latest
        ```

### Automation

The project is set up with GitHub Actions (in `.github/workflows/ci.yml`) to run tests on every push. You can extend this to automatically publish to NPM on release creation if desired.
