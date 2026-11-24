// Settings shape, defaults and parsing. Pure, no Obsidian runtime imports.
import { createHistory, parseHistory, type FolderHistory } from "./history.ts";

export const FolderDisplayMode = {
    DEFAULT: "default",
    RECENCY: "recency",
    FREQUENCY: "frequency",
} as const;
export type FolderDisplayMode =
    (typeof FolderDisplayMode)[keyof typeof FolderDisplayMode];

export interface PluginSettings {
    maxResults: number;
    expandTargetFolder: boolean;
    debugMode: boolean;
    folderDisplayMode: FolderDisplayMode;
    recentFoldersToShow: number;
    frequentFoldersToShow: number;
    folderHistory: FolderHistory;
    newFolderLocation: string; // Path where new folders are created ("" = vault root)
}

export function defaultSettings(): PluginSettings {
    return {
        maxResults: 10,
        expandTargetFolder: true,
        debugMode: false,
        folderDisplayMode: FolderDisplayMode.DEFAULT,
        recentFoldersToShow: 5,
        frequentFoldersToShow: 5,
        folderHistory: createHistory(),
        newFolderLocation: "",
    };
}

function clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

function isDisplayMode(value: unknown): value is FolderDisplayMode {
    return (Object.values(FolderDisplayMode) as unknown[]).includes(value);
}

/**
 * Build valid settings from whatever `loadData()` returned (null on first run,
 * or a possibly hand-edited / synced data.json). Unknown keys are dropped;
 * wrong types fall back to defaults; numbers are clamped to the UI ranges.
 */
export function parseSettings(raw: unknown): PluginSettings {
    const d = defaultSettings();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return d;
    }
    const r = raw as Record<string, unknown>;
    return {
        maxResults: clampInt(r.maxResults, 5, 50, d.maxResults),
        expandTargetFolder:
            typeof r.expandTargetFolder === "boolean"
                ? r.expandTargetFolder
                : d.expandTargetFolder,
        debugMode: typeof r.debugMode === "boolean" ? r.debugMode : d.debugMode,
        folderDisplayMode: isDisplayMode(r.folderDisplayMode)
            ? r.folderDisplayMode
            : d.folderDisplayMode,
        recentFoldersToShow: clampInt(
            r.recentFoldersToShow,
            1,
            20,
            d.recentFoldersToShow,
        ),
        frequentFoldersToShow: clampInt(
            r.frequentFoldersToShow,
            1,
            20,
            d.frequentFoldersToShow,
        ),
        folderHistory: parseHistory(r.folderHistory),
        newFolderLocation:
            typeof r.newFolderLocation === "string"
                ? r.newFolderLocation
                : d.newFolderLocation,
    };
}
