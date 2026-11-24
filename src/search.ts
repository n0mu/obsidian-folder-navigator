// Folder search scoring and dedupe. Pure: no Obsidian runtime imports, so it
// can be unit-tested with `node --test`.
// CHARACTERIZATION COPY: logic lifted verbatim from FolderSuggestModal.getSuggestions.

export interface FolderLike {
    path: string;
    name: string;
}

export interface SearchHit<F extends FolderLike> {
    folder: F;
    score: number;
    matches: Array<[number, number]>;
}

export function searchFolders<F extends FolderLike>(
    folders: readonly F[],
    query: string,
    limit: number,
): SearchHit<F>[] {
    const normalizedQuery = query.toLowerCase().trim();
    const keywords = normalizedQuery.split(/\s+/).filter((k) => k.length > 0);

    const foldersWithScore: SearchHit<F>[] = [];

    for (const folder of folders) {
        const folderPath = folder.path.toLowerCase();
        const folderName = folder.name.toLowerCase();
        const originalPath = folder.path;

        let allKeywordsMatch = true;
        let totalScore = 0;
        const matchPositions: Array<[number, number]> = [];

        for (const keyword of keywords) {
            const pathIndex = folderPath.indexOf(keyword);
            const nameIndex = folderName.indexOf(keyword);

            if (pathIndex === -1) {
                allKeywordsMatch = false;
                break;
            }

            const originalPathLower = originalPath.toLowerCase();
            let pos = 0;
            while ((pos = originalPathLower.indexOf(keyword, pos)) !== -1) {
                for (let i = 0; i < keyword.length; i++) {
                    matchPositions.push([pos + i, pos + i]);
                }
                pos += keyword.length;
            }

            let keywordScore = 0;
            if (nameIndex !== -1) {
                keywordScore += 100;
                if (folderName === keyword) {
                    keywordScore += 200;
                } else if (nameIndex === 0) {
                    keywordScore += 50;
                }
            } else {
                keywordScore += 10;
            }
            keywordScore += Math.max(0, 50 - pathIndex);
            totalScore += keywordScore;
        }

        if (allKeywordsMatch) {
            const depth = folder.path.split("/").length;
            totalScore -= depth * 5;
            totalScore += Math.max(0, 100 - folder.path.length);
            foldersWithScore.push({
                folder,
                score: totalScore,
                matches: matchPositions,
            });
        }
    }

    foldersWithScore.sort((a, b) => b.score - a.score);

    const results: SearchHit<F>[] = [];
    const parentPaths = new Set<string>();

    for (const item of foldersWithScore) {
        const folderPath = item.folder.path;
        let shouldExclude = false;
        let isChildOfMatch = false;

        for (const parentPath of parentPaths) {
            if (folderPath.startsWith(parentPath + "/")) {
                isChildOfMatch = true;
                const parentLower = parentPath.toLowerCase();
                const childLower = folderPath.toLowerCase();
                let parentOccurrences = 0;
                let childOccurrences = 0;
                for (const keyword of keywords) {
                    let pos = 0;
                    while ((pos = parentLower.indexOf(keyword, pos)) !== -1) {
                        parentOccurrences++;
                        pos += keyword.length;
                    }
                    pos = 0;
                    while ((pos = childLower.indexOf(keyword, pos)) !== -1) {
                        childOccurrences++;
                        pos += keyword.length;
                    }
                }
                if (childOccurrences <= parentOccurrences) {
                    shouldExclude = true;
                }
                break;
            }
        }

        if (!shouldExclude) {
            results.push(item);
            if (!isChildOfMatch) {
                parentPaths.add(folderPath);
            }
        }
    }

    return results.slice(0, limit);
}

/** Whether to offer "Create new folder" for `query` given the shown hits. */
export function shouldOfferCreate(
    hits: readonly SearchHit<FolderLike>[],
    query: string,
): boolean {
    const normalizedQuery = query.toLowerCase().trim();
    if (normalizedQuery.length === 0) return false;
    return !hits.some(
        (h) =>
            h.folder.path.toLowerCase() === normalizedQuery ||
            h.folder.name.toLowerCase() === normalizedQuery,
    );
}
