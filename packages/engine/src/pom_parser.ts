import { parseStringPromise } from 'xml2js';
import fs from 'fs/promises';
// Type-only import to avoid a runtime circular dependency:
// project_context.ts imports PomParser (runtime), pom_parser.ts imports only types (erased at compile time).
import type { ProjectCoordinate, ProjectDep } from './project_context.js';

export interface Dependency {
    groupId: string;
    artifactId: string;
    version?: string;
    scope?: string;
    optional?: boolean;
}

export interface PomInfo {
    dependencies: Dependency[];
}

export class PomParser {
    public static async parse(pomPath: string): Promise<PomInfo> {
        const content = await fs.readFile(pomPath, 'utf-8');
        const xml = await parseStringPromise(content, { explicitArray: false, trim: true });
        const deps: Dependency[] = [];
        const rawDeps = xml?.project?.dependencies?.dependency;
        if (rawDeps) {
            const depArray = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
            for (const dep of depArray) {
                if (!dep.groupId || !dep.artifactId) continue;
                deps.push({
                    groupId: dep.groupId,
                    artifactId: dep.artifactId,
                    version: dep.version,
                    scope: dep.scope,
                    optional: dep.optional === 'true',
                });
            }
        }
        return { dependencies: deps };
    }

    /**
     * Parses the project's own coordinate (`<groupId>/<artifactId>/<version>`)
     * with `<parent>` inheritance fallback (groupId & version inherit; artifactId
     * does NOT — the project's artifactId is its own), plus the declared
     * `<dependencies>`. Used by Module 8's project-context lens (D8.2).
     */
    public static async parseProjectInfo(pomPath: string): Promise<{
        projectCoordinate: ProjectCoordinate;
        dependencies: ProjectDep[];
    }> {
        const content = await fs.readFile(pomPath, 'utf-8');
        const xml = await parseStringPromise(content, { explicitArray: false, trim: true });
        const project = xml?.project;
        if (!project) throw new Error('Invalid POM: no <project> root element');

        // Project coordinate — inherit groupId/version from <parent> if absent.
        // artifactId does NOT inherit (the project's own artifactId is always its own).
        const parent = project.parent;
        const groupId = project.groupId ?? parent?.groupId;
        const artifactId = project.artifactId; // does NOT inherit from parent
        const version = project.version ?? parent?.version;

        if (!groupId || !artifactId || !version) {
            throw new Error(
                'Invalid POM: missing groupId/artifactId/version (and no parent to inherit from)'
            );
        }

        const projectCoordinate: ProjectCoordinate = { groupId, artifactId, version };

        // Reuse the same dependency-parsing logic as parse().
        const deps: ProjectDep[] = [];
        const rawDeps = project.dependencies?.dependency;
        if (rawDeps) {
            const depArray = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
            for (const dep of depArray) {
                if (!dep.groupId || !dep.artifactId) continue;
                deps.push({
                    groupId: dep.groupId,
                    artifactId: dep.artifactId,
                    version: dep.version,
                    scope: dep.scope,
                });
            }
        }

        return { projectCoordinate, dependencies: deps };
    }
}
