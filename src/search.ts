// Folder search: scoring, parent/child dedupe and the pinned "recent" /
// "frequent" block. Pure, no Obsidian runtime imports, so it can be
// unit-tested with `node --test`.
import { getEntry, type FolderHistory } from "./history.ts";
import { FolderDisplayMode } from "./settings.ts";

/** The parts of a `TFolder` search needs. */
export interface FolderLike {
    path: string;
    name: string;
}

/** Half-open `[start, end)` character ranges, the shape `renderMatches` takes. */
export type MatchRanges = Array<[number, number]>;

export interface SearchHit<F extends FolderLike> {
    folder: F;
    score: number;
    /** Sorted, non-overlapping ranges of `folder.path` to highlight. */
    matches: MatchRanges;
}

/** Lower-cased, whitespace-separated keywords of `query`. */
export function parseKeywords(query: string): string[] {
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((k) => k.length > 0);
}

/** Start index of each non-overlapping occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
    const found: number[] = [];
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        found.push(pos);
        pos += needle.length;
    }
    return found;
}

export function countOccurrences(haystack: string, needle: string): number {
    return occurrences(haystack, needle).length;
}

/** Sort and merge overlapping or touching ranges. */
export function mergeRanges(ranges: MatchRanges): MatchRanges {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: MatchRanges = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) {
            last[1] = Math.max(last[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

/** Score for one keyword already known to occur in `path` (both lower-cased). */
function keywordScore(path: string, name: string, keyword: string): number {
    const nameIndex = name.indexOf(keyword);
    let score: number;
    if (nameIndex === -1)
        score = 10; // only in a parent segment
    else if (name === keyword)
        score = 300; // exact name
    else if (nameIndex === 0)
        score = 150; // name starts with it
    else score = 100; // elsewhere in the name
    return score + Math.max(0, 50 - path.indexOf(keyword)); // earlier is better
}

/** Score `folder` against `keywords`, or null if any keyword is missing. */
function scoreFolder<F extends FolderLike>(
    folder: F,
    keywords: readonly string[],
): SearchHit<F> | null {
    const path = folder.path.toLowerCase();
    const name = folder.name.toLowerCase();
    let score = 0;
    const ranges: MatchRanges = [];
    for (const keyword of keywords) {
        const starts = occurrences(path, keyword);
        if (starts.length === 0) return null;
        for (const start of starts)
            ranges.push([start, start + keyword.length]);
        score += keywordScore(path, name, keyword);
    }
    score -= folder.path.split("/").length * 5; // prefer shallow folders
    score += Math.max(0, 100 - folder.path.length); // and short paths
    return { folder, score, matches: mergeRanges(ranges) };
}

function totalOccurrences(path: string, keywords: readonly string[]): number {
    const lower = path.toLowerCase();
    return keywords.reduce((n, k) => n + countOccurrences(lower, k), 0);
}

/**
 * Folders matching every keyword of `query` (any order, case-insensitive),
 * best first; ties keep the input order. A folder whose top-level matching
 * ancestor is already listed is dropped unless it contains more keyword
 * occurrences than that ancestor. Returns at most `limit` hits.
 */
export function searchFolders<F extends FolderLike>(
    folders: readonly F[],
    query: string,
    limit: number,
): SearchHit<F>[] {
    const keywords = parseKeywords(query);
    if (keywords.length === 0) return [];

    const scored = folders
        .map((f) => scoreFolder(f, keywords))
        .filter((h): h is SearchHit<F> => h !== null)
        .sort((a, b) => b.score - a.score);

    const results: SearchHit<F>[] = [];
    const parents: string[] = [];
    for (const hit of scored) {
        const path = hit.folder.path;
        const parent = parents.find((p) => path.startsWith(p + "/"));
        if (parent === undefined) {
            parents.push(path);
            results.push(hit);
        } else if (
            totalOccurrences(path, keywords) >
            totalOccurrences(parent, keywords)
        ) {
            results.push(hit);
        }
    }
    return results.slice(0, limit);
}

/** Whether to offer "Create new folder" for `query` given the shown hits. */
export function shouldOfferCreate(
    hits: readonly SearchHit<FolderLike>[],
    query: string,
): boolean {
    const q = query.toLowerCase().trim();
    if (q.length === 0) return false;
    return !hits.some(
        (h) =>
            h.folder.path.toLowerCase() === q ||
            h.folder.name.toLowerCase() === q,
    );
}

/**
 * Up to `limit` visited folders to pin above the full list: most recently
 * visited first in recency mode, most visited first in frequency mode, and
 * none in default mode. Ties keep the input order.
 */
export function pinnedFolders<F extends FolderLike>(
    folders: readonly F[],
    history: FolderHistory,
    mode: FolderDisplayMode,
    limit: number,
): F[] {
    if (mode === FolderDisplayMode.DEFAULT) return [];
    const key =
        mode === FolderDisplayMode.RECENCY ? "lastAccessed" : "accessCount";
    return folders
        .map((folder) => ({ folder, entry: getEntry(history, folder.path) }))
        .filter((x) => x.entry !== undefined)
        .sort((a, b) => (b.entry?.[key] ?? 0) - (a.entry?.[key] ?? 0))
        .slice(0, limit)
        .map((x) => x.folder);
}
