import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Cross-process lock for indexing passes.
 *
 * The MCP server and the CLI share one SQLite file, and an agent may start
 * several MCP servers at once. Letting each of them scan and write the same
 * index always ends in `SQLITE_BUSY: database is locked` (and duplicated work).
 * Only the lock owner runs a pass; the other processes skip theirs and read
 * the index the owner is building.
 *
 * This is a plain file lock, not a SQLite transaction: it covers the whole
 * pass, including the file-system scan that happens before the first write.
 */
export const INDEX_LOCK_SUFFIX = '.index.lock';

const DEFAULT_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 5 * 60_000;
/** Grace period for a lock file that was created but not yet written. */
const WRITE_GRACE_MS = 5_000;

interface LockPayload {
    pid: number;
    token: string;
    startedAt: number;
}

export function indexLockPath(dbPath: string): string {
    return `${dbPath}${INDEX_LOCK_SUFFIX}`;
}

/**
 * How long a pass waits for another process before skipping. Override with
 * `MAVEN_INDEXER_INDEX_LOCK_WAIT_MS` (0 = skip immediately).
 */
export function indexLockWaitMs(): number {
    const raw = Number(process.env.MAVEN_INDEXER_INDEX_LOCK_WAIT_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WAIT_MS;
}

function readPayload(lockPath: string): LockPayload | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockPayload>;
        return typeof parsed.pid === 'number' && typeof parsed.token === 'string'
            ? parsed as LockPayload
            : null;
    } catch {
        return null;
    }
}

function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        // A process we cannot signal still exists; only ESRCH means it is gone.
        return e?.code === 'EPERM';
    }
}

/**
 * A lock is abandoned when its owner died, when it never got written (partial
 * create), or when its heartbeat stopped. The mtime check also covers PID reuse
 * and a hung owner; the owner refreshes it while indexing.
 */
function isStale(lockPath: string): boolean {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(lockPath);
    } catch {
        return false; // removed by another process; retry the create
    }
    const payload = readPayload(lockPath);
    if (!payload) {
        return Date.now() - stat.mtimeMs > WRITE_GRACE_MS;
    }
    if (!isPidAlive(payload.pid)) return true;
    return Date.now() - stat.mtimeMs > STALE_AFTER_MS;
}

/** Owns the lock file until `release()` is called. */
export class IndexLock {
    private timer: NodeJS.Timeout | null;
    private released = false;

    constructor(private readonly lockPath: string, private readonly token: string) {
        this.timer = setInterval(() => this.beat(), HEARTBEAT_MS);
        this.timer.unref();
    }

    /** Refresh the mtime so a long pass is not mistaken for a dead owner. */
    beat(): void {
        if (this.released) return;
        try {
            if (readPayload(this.lockPath)?.token !== this.token) return;
            const now = new Date();
            fs.utimesSync(this.lockPath, now, now);
        } catch {
            // The lock file was removed or taken over; nothing to refresh.
        }
    }

    release(): void {
        if (this.released) return;
        this.released = true;
        if (this.timer) clearInterval(this.timer);
        try {
            // Never delete a lock that another process has since taken over.
            if (readPayload(this.lockPath)?.token === this.token) {
                fs.unlinkSync(this.lockPath);
            }
        } catch {
            // Already gone.
        }
    }
}

function tryCreate(lockPath: string): IndexLock | null {
    const token = randomUUID();
    const payload: LockPayload = { pid: process.pid, token, startedAt: Date.now() };
    let fd: number;
    try {
        // 'wx' is atomic across processes on every supported platform.
        fd = fs.openSync(lockPath, 'wx');
    } catch (e: any) {
        if (e?.code === 'EEXIST') return null;
        throw e;
    }
    try {
        fs.writeSync(fd, JSON.stringify(payload));
    } finally {
        fs.closeSync(fd);
    }
    return new IndexLock(lockPath, token);
}

/**
 * Acquires the index lock, waiting up to `waitMs` for the current owner.
 * Returns `null` when another process is still indexing, so the caller can
 * skip its pass rather than fight over SQLite's write lock.
 */
export async function acquireIndexLock(dbPath: string, waitMs = indexLockWaitMs()): Promise<IndexLock | null> {
    const lockPath = indexLockPath(dbPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + waitMs;

    for (;;) {
        const lock = tryCreate(lockPath);
        if (lock) return lock;
        if (isStale(lockPath)) {
            try {
                fs.unlinkSync(lockPath);
            } catch {
                // Another process removed it first.
            }
            // Retry the create right away: reclaiming a stale lock is not a
            // wait, and with waitMs = 0 we must still succeed on this attempt.
            const reclaimed = tryCreate(lockPath);
            if (reclaimed) return reclaimed;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
}
