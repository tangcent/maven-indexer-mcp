# Maven Indexer MCP Server Plan

## 1. Goal & MVP Functionality

The goal of this server is to provide an interface for AI agents to understand and search the contents of the local Maven repository.

### a. Index Building
- **Objective**: Build a comprehensive index of the entire local Maven repository.
- **Scope**:
  - Scan artifacts in the local repository structure.
  - Parse JARs (classes and sources if available).
  - Index metadata (groupId, artifactId, version) and content (class names, method signatures).

### b. Search APIs
- **Objective**: Provide MCP tools/resources for AI to query the index.
- **Capabilities**:
  - Search for artifacts by coordinates.
  - Search for classes by name.
  - Search for code usage or definitions (depending on source availability).

## 2. Configuration Design

The server will support the following configuration properties to customize behavior.

### a. `localRepository`
- **Description**: The path to the local Maven repository to be indexed.
- **Resolution Logic**:
  1. If explicitly set in config, use the provided path.
  2. If not set, check `$HOME/.m2/settings.xml` for `<localRepository>`.
  3. Check `$M2_HOME/conf/settings.xml` for `<localRepository>`.
  4. Fallback to default: `$HOME/.m2/repository`.

### b. `includedPackages` (Specific Packages)
- **Description**: A list of package patterns to restrict indexing.
- **Default**: `["*"]` (Index all packages).
- **Usage**:
  - Users can specify `["com.mycompany.*", "org.springframework.*"]` to only index relevant codebases.
  - Reduces index size and noise.

### c. Additional Configuration (Proposed)
- **`excludePackages`**: Patterns to explicitly exclude.
- **`indexSources`**: Boolean flag to indicate if source code inside source jars should be indexed (default: true).
- **`maxDepth`**: Depth of dependency traversal if we implement transitive dependency resolution (optional for MVP).

## 3.  **Index Structure Design (Updated)**

We have transitioned from an in-memory index to a persistent SQLite-based index to handle large repositories and support advanced search capabilities (FTS).

### a. Database Schema (SQLite)

1.  **`artifacts` Table**
    *   `id`: INTEGER PRIMARY KEY
    *   `group_id`: TEXT
    *   `artifact_id`: TEXT
    *   `version`: TEXT
    *   `abspath`: TEXT (Path to artifact directory)
    *   `has_source`: INTEGER (Boolean flag, 1 if sources JAR exists)
    *   `is_indexed`: INTEGER (Boolean flag, 1 if classes have been indexed)
    *   Unique constraint on (group_id, artifact_id, version).

2.  **`classes_fts` Virtual Table (FTS5)**
    *   `artifact_id`: UNINDEXED (Foreign Key to artifacts)
    *   `class_name`: TEXT (Fully Qualified Name, e.g., `com.example.MyClass`)
    *   `simple_name`: TEXT (Simple Name, e.g., `MyClass`)
    *   Tokenized with `trigram` tokenizer for efficient partial matching.

### b. Indexing Strategy
*   **Scanning**:
    *   Walk the directory structure of the local Maven repository.
    *   Identify `.pom` files to determine artifact coordinates.
    *   Check for existence of `-sources.jar`.
    *   Insert metadata into `artifacts` table with `is_indexed = 0`.
*   **Processing**:
    *   Identify artifacts where `is_indexed = 0`.
    *   Open the main JAR using `yauzl`.
    *   Extract class names from `.class` entries.
    *   Batch insert class names into `classes_fts`.
    *   Update `artifacts` table setting `is_indexed = 1`.
*   **On-Demand Details**:
    *   Full source code, method signatures, and Javadocs are **not** stored in the DB.
    *   They are extracted on-demand from the `-sources.jar` when requested via `get_class_details` tool.

## 4. MCP Tool Definitions

### a. `search_classes`
*   **Description**: Search for Java classes by name or purpose.
*   **Inputs**: `className` (string) - Can be FQCN, partial name, or keywords (e.g., "JsonToXml").
*   **Logic**: Uses SQLite FTS5 to find matching classes. Returns class names and their containing artifact coordinates.

### b. `get_class_details`
*   **Description**: Get details for a specific class.
*   **Inputs**:
    *   `className`: FQCN.
    *   `artifactId`: ID of the artifact (returned from search).
    *   `type`: "signatures" | "docs" | "source".
*   **Logic**:
    *   Locates the source JAR for the artifact.
    *   Parses the source file for the requested class.
    *   Returns the requested detail level (signatures only, javadocs + signatures, or full source).

## 5. Implementation Status

- [x] Project Setup & Configuration
- [x] SQLite Database Implementation
- [x] Indexer Logic (Scanning & DB Population)
- [x] Source Code Parser (On-demand extraction)
- [x] MCP Server & Tools (`search_classes`, `get_class_details`)
- [x] Testing & Verification (Full flow with test repo)


