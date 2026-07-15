import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { Config, VersionStrategy } from './config.js';
import { Artifact } from './indexer.js';

export type ArtifactComparator = (a: Artifact, b: Artifact) => number;

export class ArtifactResolver {

    private static strategies: Record<VersionStrategy, ArtifactComparator> = {
        'semver': ArtifactResolver.compareSemver,
        'latest-published': ArtifactResolver.compareLatestPublished,
        'latest-used': ArtifactResolver.compareLatestUsed
    };

    static async resolveBestArtifact(artifacts: Artifact[]): Promise<Artifact | undefined> {
        if (!artifacts || artifacts.length === 0) return undefined;

        const config = await Config.getInstance();
        const comparator = this.strategies[config.versionResolutionStrategy] || this.strategies['semver'];

        const sorted = [...artifacts].sort((a, b) => {
            // 1. Always prefer source if available
            if (a.hasSource !== b.hasSource) {
                return a.hasSource ? -1 : 1; // source comes first
            }

            // 2. Apply configured strategy
            try {
                return comparator(a, b);
            } catch (e) {
                // Fallback to ID comparison (likely insert order)
                return b.id - a.id;
            }
        });

        return sorted[0];
    }

    private static compareSemver(a: Artifact, b: Artifact): number {
        const vA = semver.coerce(a.version);
        const vB = semver.coerce(b.version);

        if (vA && vB) {
            const comparison = semver.rcompare(vA, vB);
            if (comparison !== 0) return comparison;
        }

        if (semver.valid(a.version) && semver.valid(b.version)) {
            return semver.rcompare(a.version, b.version);
        }

        // Fallback for non-semver strings
        return b.id - a.id;
    }

    private static getArtifactFileTime(artifact: Artifact, timeType: 'mtime' | 'birthtime'): number {
        let p = artifact.abspath;
        try {
            if (fs.statSync(p).isDirectory()) {
                // Try jar first, then pom
                const jarPath = path.join(p, `${artifact.artifactId}-${artifact.version}.jar`);
                if (fs.existsSync(jarPath)) return fs.statSync(jarPath)[timeType].getTime();

                const pomPath = path.join(p, `${artifact.artifactId}-${artifact.version}.pom`);
                if (fs.existsSync(pomPath)) return fs.statSync(pomPath)[timeType].getTime();
            }
            return fs.statSync(p)[timeType].getTime();
        } catch {
            return 0;
        }
    }

    private static getArtifactPublishTime(artifact: Artifact): number {
        let p = artifact.abspath;
        try {
            // 1. Try to read .lastUpdated file (priority)
            if (fs.statSync(p).isDirectory()) {
                const pomPath = path.join(p, `${artifact.artifactId}-${artifact.version}.pom`);
                const lastUpdatedPath = `${pomPath}.lastUpdated`;

                if (fs.existsSync(lastUpdatedPath)) {
                    try {
                        const content = fs.readFileSync(lastUpdatedPath, 'utf-8');
                        // Try to find property with timestamp
                        const matches = content.match(/lastUpdated=(\d{13})/g);
                        if (matches) {
                            let maxTime = 0;
                            for (const match of matches) {
                                const ts = parseInt(match.split('=')[1]);
                                if (!isNaN(ts) && ts > maxTime) maxTime = ts;
                            }
                            if (maxTime > 0) return maxTime;
                        }
                    } catch (e) {
                        // ignore parse error
                    }
                }
            }

            // 2. Fallback to mtime
            return ArtifactResolver.getArtifactFileTime(artifact, 'mtime');
        } catch {
            return 0;
        }
    }

    private static compareLatestPublished(a: Artifact, b: Artifact): number {
        const tA = ArtifactResolver.getArtifactPublishTime(a);
        const tB = ArtifactResolver.getArtifactPublishTime(b);
        return tB - tA; // Newer first
    }

    private static compareLatestUsed(a: Artifact, b: Artifact): number {
        const tA = ArtifactResolver.getArtifactFileTime(a, 'birthtime');
        const tB = ArtifactResolver.getArtifactFileTime(b, 'birthtime');
        return tB - tA; // Newer first
    }
}
