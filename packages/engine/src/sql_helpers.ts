/**
 * Escapes a string for use as a literal inside a SQLite `LIKE` pattern,
 * so that `%` and `_` in user input are treated as literals.
 * Use together with `LIKE ? ESCAPE '\'`.
 */
export function escapeLike(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Wraps a LIKE pattern around an escaped literal. */
export function likeContains(s: string): string {
    return `%${escapeLike(s)}%`;
}

/**
 * Builds a syntactically valid FTS5 query string for any user-supplied pattern.
 * Each whitespace-separated token is wrapped in double-quotes (with inner
 * quotes doubled) and tokens are joined with OR. An empty/whitespace pattern
 * yields `""` (matches nothing — caller should handle empty input).
 */
export function buildFtsQuery(pattern: string): string {
    const tokens = pattern.trim().split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
    return tokens.length ? tokens.join(' OR ') : '""';
}

/** Maximum regex length accepted from user input (defense against ReDoS). */
export const MAX_REGEX_LENGTH = 256;

/** Compiles a user regex with a length cap; throws on invalid/too-long input. */
export function compileUserRegex(pattern: string): RegExp {
    if (pattern.length > MAX_REGEX_LENGTH) {
        throw new Error(`Regex too long (max ${MAX_REGEX_LENGTH} chars)`);
    }
    return new RegExp(pattern);
}
