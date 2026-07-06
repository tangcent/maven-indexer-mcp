import { parseStringPromise } from 'xml2js';
import fs from 'fs/promises';

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
}
