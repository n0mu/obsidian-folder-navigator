// Folder visit history. Pure functions with no Obsidian runtime imports, so
// they can be unit-tested with `node --test`.

export interface FolderHistoryEntry {
    lastAccessed: number; // epoch ms
    accessCount: number;
}

/**
 * Keyed by vault-relative folder path. Always create with `createHistory()`:
 * a null-prototype object, so paths like "constructor" or "__proto__" are
 * ordinary keys rather than inherited members.
 */
export type FolderHistory = Record<string, FolderHistoryEntry>;

export const MAX_HISTORY_ENTRIES = 200;

export function createHistory(): FolderHistory {
    return Object.create(null) as FolderHistory;
}

function hasEntry(history: FolderHistory, path: string): boolean {
    return Object.prototype.hasOwnProperty.call(history, path);
}

export function getEntry(
    history: FolderHistory,
    path: string,
): FolderHistoryEntry | undefined {
    return hasEntry(history, path) ? history[path] : undefined;
}

function isDescendantOrSelf(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(ancestor + "/");
}

/** Drop the least recently used entries beyond `max`. Returns true if any were dropped. */
export function pruneHistory(
    history: FolderHistory,
    max: number = MAX_HISTORY_ENTRIES,
): boolean {
    const paths = Object.keys(history);
    if (paths.length <= max) return false;
    paths
        .sort((a, b) => history[b].lastAccessed - history[a].lastAccessed)
        .slice(max)
        .forEach((p) => delete history[p]);
    return true;
}

export function recordVisit(
    history: FolderHistory,
    path: string,
    now: number,
): void {
    const entry = getEntry(history, path);
    history[path] = {
        lastAccessed: now,
        accessCount: (entry?.accessCount ?? 0) + 1,
    };
    pruneHistory(history);
}

/** Re-key `oldPath` and everything below it to `newPath`. Returns true if anything changed. */
export function renameInHistory(
    history: FolderHistory,
    oldPath: string,
    newPath: string,
): boolean {
    if (oldPath === newPath) return false;
    let changed = false;
    for (const path of Object.keys(history)) {
        if (!isDescendantOrSelf(path, oldPath)) continue;
        const moved = newPath + path.slice(oldPath.length);
        const entry = history[path];
        delete history[path];
        const existing = getEntry(history, moved);
        history[moved] = existing
            ? {
                  lastAccessed: Math.max(
                      existing.lastAccessed,
                      entry.lastAccessed,
                  ),
                  accessCount: existing.accessCount + entry.accessCount,
              }
            : entry;
        changed = true;
    }
    return changed;
}

/** Remove `path` and everything below it. Returns true if anything changed. */
export function deleteFromHistory(
    history: FolderHistory,
    path: string,
): boolean {
    let changed = false;
    for (const key of Object.keys(history)) {
        if (isDescendantOrSelf(key, path)) {
            delete history[key];
            changed = true;
        }
    }
    return changed;
}

function isValidEntry(value: unknown): value is FolderHistoryEntry {
    if (typeof value !== "object" || value === null) return false;
    const { lastAccessed, accessCount } = value as Record<string, unknown>;
    return (
        typeof lastAccessed === "number" &&
        Number.isFinite(lastAccessed) &&
        lastAccessed >= 0 &&
        typeof accessCount === "number" &&
        Number.isInteger(accessCount) &&
        accessCount >= 1
    );
}

/** Build a clean history from untrusted data (e.g. a hand-edited data.json). */
export function parseHistory(raw: unknown): FolderHistory {
    const history = createHistory();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return history;
    }
    for (const [path, value] of Object.entries(raw)) {
        if (path.length > 0 && isValidEntry(value)) {
            history[path] = {
                lastAccessed: value.lastAccessed,
                accessCount: value.accessCount,
            };
        }
    }
    pruneHistory(history);
    return history;
}
