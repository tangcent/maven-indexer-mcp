import { DB } from '@maven-indexer/engine';
import { Indexer, Artifact, CallEdgeResult } from '@maven-indexer/engine';
import { SourceParser } from '@maven-indexer/engine';
import { ArtifactResolver } from '@maven-indexer/engine';
import { resolveMainJar } from '@maven-indexer/engine';
import { GlobalOpts, resolveDbPath, assertIndexNotEmpty } from './shared.js';
import { print } from '@maven-indexer/engine';
import { resolve as smartResolve } from '@maven-indexer/engine';

/**
 * `trace` — composed, capped view of a class and its immediate neighbors.
 * (Module 2 / requirements-trace-command.md)
 *
 * Composes:
 *   - `class`        — signatures of the target (null if not found)
 *   - `implementations` — subclasses/implementations (capped)
 *   - `callers`      — direct caller methods from the call graph (capped, empty if no CG)
 *   - `callees`      — direct callee methods from the call graph (capped, empty if no CG)
 *   - `_meta`        — status, callGraphAvailable, per-section truncation counts
 */

export interface TraceClassResult {
    className: string;
    artifact: string; // "g:a:v"
    signatures: string[];
}

export interface TraceNeighborResult {
    className: string;
    artifact: string; // "g:a:v"
}

export interface TraceCallEdgeResult {
    className: string;
    methodName: string;
    artifact: string; // "g:a:v" or ""
    sites: number;
}

export interface TraceMeta {
    status: 'found' | 'not_found';
    callGraphAvailable: boolean;
    truncated: {
        implementations: number;
        callers: number;
        callees: number;
    };
}

export interface TraceResult {
    class: TraceClassResult | null;
    implementations: TraceNeighborResult[];
    callers: TraceCallEdgeResult[];
    callees: TraceCallEdgeResult[];
    _meta: TraceMeta;
}

export interface TraceOpts extends GlobalOpts {
    coordinate?: string;
    limitImplementations?: number;
    limitCallers?: number;
    limitCallees?: number;
    maxLines?: number;
}

function artifactCoord(a: Artifact): string {
    return `${a.groupId}:${a.artifactId}:${a.version}`;
}

export async function run(className: string, opts: TraceOpts): Promise<void> {
    const db = DB.getInstance(resolveDbPath());
    assertIndexNotEmpty(db);
    const indexer = Indexer.getInstance();

    // Smart-resolve simple names
    let resolvedName = className;
    if (!className.includes('.')) {
        const fqn = await smartResolve(className, process.cwd());
        if (fqn) {
            resolvedName = fqn;
        }
    }

    const limitImpl = opts.limitImplementations ?? 10;
    const limitCallers = opts.limitCallers ?? 10;
    const limitCallees = opts.limitCallees ?? 10;

    // --- Class section: find the class and get signatures ---
    let classResult: TraceClassResult | null = null;
    let status: 'found' | 'not_found' = 'not_found';

    const matches = indexer.searchClass(resolvedName);
    const exactMatch = matches.find((m: any) => m.className === resolvedName);

    if (exactMatch) {
        const bestArtifact = await ArtifactResolver.resolveBestArtifact(exactMatch.artifacts);
        if (bestArtifact) {
            try {
                const mainJarPath = resolveMainJar(bestArtifact);
                const detail = await SourceParser.getClassDetail(mainJarPath, resolvedName, 'signatures');
                classResult = {
                    className: detail?.className ?? resolvedName,
                    artifact: artifactCoord(bestArtifact),
                    signatures: detail?.signatures ?? [],
                };
                status = 'found';
            } catch {
                // Class found in index but JAR unreadable — still report found with empty signatures
                classResult = {
                    className: resolvedName,
                    artifact: artifactCoord(bestArtifact),
                    signatures: [],
                };
                status = 'found';
            }
        }
    }

    // --- Implementations section ---
    const implRaw = indexer.searchImplementations(resolvedName, limitImpl + 1);
    const implTruncated = Math.max(0, implRaw.length - limitImpl);
    const implCapped = implRaw.slice(0, limitImpl);
    const implementations: TraceNeighborResult[] = implCapped.map((m: any) => ({
        className: m.className,
        artifact: m.artifacts.length > 0 ? artifactCoord(m.artifacts[0]) : '',
    }));

    // --- Callers / Callees (degrade gracefully if no call graph) ---
    let callGraphAvailable = false;
    let callers: TraceCallEdgeResult[] = [];
    let callees: TraceCallEdgeResult[] = [];
    let callersTruncated = 0;
    let calleesTruncated = 0;

    try {
        callGraphAvailable = indexer.isCallGraphAvailable();
    } catch {
        callGraphAvailable = false;
    }

    if (callGraphAvailable) {
        const callersRaw: CallEdgeResult[] = indexer.searchCallers(resolvedName, undefined, limitCallers + 1);
        callersTruncated = Math.max(0, callersRaw.length - limitCallers);
        callers = callersRaw.slice(0, limitCallers).map((e: CallEdgeResult) => ({
            className: e.className,
            methodName: e.methodName,
            artifact: e.artifacts.length > 0 ? artifactCoord(e.artifacts[0]) : '',
            sites: e.sites,
        }));

        const calleesRaw: CallEdgeResult[] = indexer.searchCallees(resolvedName, undefined, limitCallees + 1);
        calleesTruncated = Math.max(0, calleesRaw.length - limitCallees);
        callees = calleesRaw.slice(0, limitCallees).map((e: CallEdgeResult) => ({
            className: e.className,
            methodName: e.methodName,
            artifact: e.artifacts.length > 0 ? artifactCoord(e.artifacts[0]) : '',
            sites: e.sites,
        }));
    }

    const result: TraceResult = {
        class: classResult,
        implementations,
        callers,
        callees,
        _meta: {
            status,
            callGraphAvailable,
            truncated: {
                implementations: implTruncated,
                callers: callersTruncated,
                callees: calleesTruncated,
            },
        },
    };

    print('trace', result, opts);
}
