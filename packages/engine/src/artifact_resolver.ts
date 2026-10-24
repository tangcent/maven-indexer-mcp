import fs from 'fs';
import path from 'path';
import semver from 'semver';
import { Config, VersionStrategy } from './config.js';
import { Artifact } from './indexer.js';

export type ArtifactComparator = (a: Artifact, b: Artifact) => number;

/** Qualifier order for `compareMavenVersions`; unknown qualifiers rank as OTHER_RANK. */
const QUALIFIER_RANK: Record<string, number> = {
    alpha: 1, a: 1, beta: 2, b: 2, milestone: 3, m: 3, rc: 4, cr: 4,
    snapshot: 5, '': 6, ga: 6, final: 6, release: 6, sp: 7,
};
const OTHER_RANK = 8;

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

    /** Display order for search results: groupId, artifactId, then newest version first. */
    static compareForListing(a: Artifact, b: Artifact): number {
        return a.groupId.localeCompare(b.groupId)
            || a.artifactId.localeCompare(b.artifactId)
            || ArtifactResolver.compareMavenVersions(b.version, a.version);
    }

    /**
     * Compares Maven version strings, a simplified form of Maven's
     * ComparableVersion: `.`/`-` and digit/letter boundaries split the version
     * into items, numbers compare numerically, and qualifiers rank
     * alpha < beta < milestone < rc < snapshot < release < sp < other.
     * A missing item counts as 0 against a number and as a release against a
     * qualifier, so `1.0 == 1.0.0` and `1.0-SNAPSHOT < 1.0 < 1.0.1`.
     * Returns a negative number when `a` is older than `b`.
     */
    static compareMavenVersions(a: string, b: string): number {
        const tokenize = (v: string): (number | string)[] => {
            const tokens = v.toLowerCase().match(/\d+|[a-z]+/g)
                ?.map(t => /^\d/.test(t) ? Number(t) : t) ?? [];
            const qualifierIndex = tokens.findIndex(t => typeof t === 'string');
            let coreEnd = qualifierIndex < 0 ? tokens.length : qualifierIndex;
            // Normalize the numeric core before comparing qualifiers: 1.0-rc1
            // and 1.0.0-rc1 must have the same qualifier position.
            const originalCoreEnd = coreEnd;
            while (coreEnd > 1 && tokens[coreEnd - 1] === 0) coreEnd--;
            tokens.splice(coreEnd, originalCoreEnd - coreEnd);
            return tokens;
        };
        const ta = tokenize(a);
        const tb = tokenize(b);
        for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
            const x = ta[i] ?? (typeof tb[i] === 'number' ? 0 : '');
            const y = tb[i] ?? (typeof ta[i] === 'number' ? 0 : '');
            if (typeof x === 'number' && typeof y === 'number') {
                if (x !== y) return x - y;
            } else if (typeof x === 'number') {
                return 1; // 1.0.1 > 1.0-beta
            } else if (typeof y === 'number') {
                return -1;
            } else {
                const rx = QUALIFIER_RANK[x] ?? OTHER_RANK;
                const ry = QUALIFIER_RANK[y] ?? OTHER_RANK;
                if (rx !== ry) return rx - ry;
                // Known aliases (ga/final/release, a/alpha, ...) are equal; unknown ones compare by name.
                if (rx === OTHER_RANK && x !== y) return x.localeCompare(y);
            }
        }
        return 0;
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
