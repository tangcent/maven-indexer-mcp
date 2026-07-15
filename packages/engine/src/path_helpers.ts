import path from 'path';

export type Layout = 'maven' | 'gradle';

export interface ArtifactLike {
    abspath: string;
    artifactId: string;
    version: string;
    layout?: Layout | null;
}

/**
 * Classifiers that are never the "main" JAR.
 * Kept in one place so Maven and Gradle scan paths stay consistent.
 */
export const EXCLUDED_CLASSIFIERS = ['-sources', '-javadoc', '-tests'];

/**
 * Detects the cache layout of an artifact.
 * Prefers the recorded `layout` column; falls back to the legacy
 * `abspath.endsWith('.jar')` heuristic for pre-migration rows.
 */
export function detectLayout(artifact: ArtifactLike): Layout {
    if (artifact.layout) return artifact.layout;
    return artifact.abspath.endsWith('.jar') ? 'gradle' : 'maven';
}

/**
 * Resolves the main JAR file path for an artifact.
 * - Gradle layout: abspath is already the JAR file path.
 * - Maven layout: abspath is the version directory; the JAR is inside it.
 */
export function resolveMainJar(artifact: ArtifactLike): string {
    if (detectLayout(artifact) === 'gradle') return artifact.abspath;
    return path.join(artifact.abspath, `${artifact.artifactId}-${artifact.version}.jar`);
}

/**
 * Resolves the sources JAR file path for an artifact.
 * - Gradle layout: sources JAR is a sibling of the main JAR (in the hash dir).
 * - Maven layout: sources JAR is inside the version directory.
 */
export function resolveSourcesJar(artifact: ArtifactLike): string {
    const sourcesName = `${artifact.artifactId}-${artifact.version}-sources.jar`;
    if (detectLayout(artifact) === 'gradle') return path.join(path.dirname(artifact.abspath), sourcesName);
    return path.join(artifact.abspath, sourcesName);
}

/**
 * Resolves the version directory for an artifact.
 * - Gradle layout: the version dir is the parent of the hash dir containing the JAR.
 * - Maven layout: abspath is already the version directory.
 */
export function resolveVersionDir(artifact: ArtifactLike): string {
    if (detectLayout(artifact) === 'gradle') return path.dirname(path.dirname(artifact.abspath));
    return artifact.abspath;
}

/**
 * Picks the "main" JAR filename from a list of JAR filenames candidates found
 * in a Gradle hash directory (or any directory).
 *
 * Rule (see requirements-gradle-parity.md Req 2 AC2):
 *   1. prefer the unsuffixed `<artifact>-<version>.jar`;
 *   2. else the `<artifact>-<version>-jre.jar` classifier;
 *   3. else the lexicographically smallest non-excluded JAR.
 *
 * Returns `null` when every JAR is excluded (e.g. only -sources/-javadoc/-tests present).
 */
export function selectMainJar(jarFileNames: string[], artifactId: string, version: string): string | null {
    const prefix = `${artifactId}-${version}`;
    const candidates = jarFileNames.filter(
        n => n.endsWith('.jar') && !EXCLUDED_CLASSIFIERS.some(c => n.endsWith(`${c}.jar`))
    );
    if (candidates.length === 0) return null;

    const unsuffixed = candidates.find(n => n === `${prefix}.jar`);
    if (unsuffixed) return unsuffixed;

    const jre = candidates.find(n => n === `${prefix}-jre.jar`);
    if (jre) return jre;

    return [...candidates].sort()[0];
}
