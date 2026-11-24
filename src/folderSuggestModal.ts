import {
    type App,
    Notice,
    SuggestModal,
    TFolder,
    normalizePath,
    renderMatches,
} from "obsidian";
import type FolderNavigatorPlugin from "./main";
import { FolderDisplayMode } from "./settings";
import { pinnedFolders, searchFolders, shouldOfferCreate } from "./search";
import { validateFolderName } from "./paths";

/** One row of the suggestion list. */
type Item =
    | { kind: "folder"; folder: TFolder; matches: Array<[number, number]> }
    | { kind: "separator"; text: string }
    | { kind: "create"; name: string };

const PINNED_HEADINGS: Partial<Record<FolderDisplayMode, string>> = {
    [FolderDisplayMode.RECENCY]: "— Recently visited folders —",
    [FolderDisplayMode.FREQUENCY]: "— Frequently visited folders —",
};

function folderItem(folder: TFolder): Item {
    return { kind: "folder", folder, matches: [] };
}

export class FolderSuggestModal extends SuggestModal<Item> {
    plugin: FolderNavigatorPlugin;
    /** Pinned (recent/frequent) folders, if any, in display order. */
    private pinned: TFolder[];
    /** Every folder: pinned ones first, then the rest in vault order. */
    private ordered: TFolder[];
    private maxResults: number;

    constructor(app: App, plugin: FolderNavigatorPlugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Type folder name...");
        this.modalEl.addClass("folder-navigator-modal");
        // SuggestModal cuts the list to `limit` after getSuggestions, which
        // would drop the "Create" row whenever there are maxResults hits.
        // Limit here instead.
        this.limit = 0;
        this.maxResults = plugin.settings.maxResults;

        const { settings } = plugin;
        const all = app.vault.getAllFolders();
        const mode = settings.folderDisplayMode;
        this.pinned = pinnedFolders(
            all,
            settings.folderHistory,
            mode,
            mode === FolderDisplayMode.RECENCY
                ? settings.recentFoldersToShow
                : settings.frequentFoldersToShow,
        );
        const pinnedSet = new Set(this.pinned);
        this.ordered = [
            ...this.pinned,
            ...all.filter((f) => !pinnedSet.has(f)),
        ];
    }

    getSuggestions(query: string): Item[] {
        if (query.trim().length === 0) return this.browseList();

        // Ties keep `ordered`, so pinned folders win equal scores.
        const hits = searchFolders(this.ordered, query, this.maxResults);
        const items: Item[] = hits.map((h) => ({
            kind: "folder",
            folder: h.folder,
            matches: h.matches,
        }));
        if (shouldOfferCreate(hits, query)) {
            if (items.length > 0)
                items.push({ kind: "separator", text: "—————" });
            items.push({ kind: "create", name: query.trim() });
        }
        return items;
    }

    /**
     * The list shown for an empty query: maxResults rows, headed by the
     * pinned block (separators count as rows, as in v0.5.0).
     */
    private browseList(): Item[] {
        const heading = PINNED_HEADINGS[this.plugin.settings.folderDisplayMode];
        const rows: Item[] =
            this.pinned.length === 0 || heading === undefined
                ? this.ordered.map(folderItem)
                : [
                      { kind: "separator", text: heading },
                      ...this.pinned.map(folderItem),
                      { kind: "separator", text: "— All folders —" },
                      ...this.ordered.slice(this.pinned.length).map(folderItem),
                  ];
        return rows.slice(0, this.maxResults);
    }

    renderSuggestion(item: Item, el: HTMLElement): void {
        switch (item.kind) {
            case "separator":
                el.addClass("fn-separator-item");
                el.createDiv({ cls: "fn-separator", text: item.text });
                return;
            case "create": {
                const row = el.createDiv({ cls: "fn-create-option" });
                row.createSpan({ cls: "fn-create-icon", text: "➕ " });
                row.createSpan({
                    cls: "fn-create-text",
                    text: `Create new folder: "${item.name}"`,
                });
                return;
            }
            case "folder":
                renderMatches(
                    el.createDiv({ cls: "suggestion-content" }),
                    item.folder.path,
                    item.matches,
                );
        }
    }

    /** Separators are headings: choosing one does nothing and keeps the modal open. */
    selectSuggestion(item: Item, evt: MouseEvent | KeyboardEvent): void {
        if (item.kind === "separator") return;
        super.selectSuggestion(item, evt);
    }

    onChooseSuggestion(item: Item): void {
        if (item.kind === "create") {
            void this.handleCreateFolder(item.name);
        } else if (item.kind === "folder") {
            this.navigateTo(item.folder);
        }
    }

    /** Record the visit and reveal the folder. The modal is already closed. */
    private navigateTo(folder: TFolder): void {
        this.plugin.recordFolderVisit(folder);
        void this.plugin.revealer.reveal(
            folder,
            this.plugin.settings.expandTargetFolder,
        );
    }

    /**
     * The configured base folder for new folders, or "" (vault root) if unset
     * or if the configured folder no longer exists.
     */
    private resolveCreateLocation(): string {
        const configured = this.plugin.settings.newFolderLocation.trim();
        if (!configured) return "";
        const path = normalizePath(configured);
        if (path === "/") return "";
        if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) {
            return path;
        }
        new Notice(
            `Default location "${path}" no longer exists; creating the folder in the vault root.`,
        );
        return "";
    }

    /** Create `path` and any missing parent folders. */
    private async createFolderRecursive(path: string): Promise<TFolder> {
        let folder = this.app.vault.getRoot();
        let current = "";
        for (const segment of path.split("/")) {
            current = current ? `${current}/${segment}` : segment;
            const existing = this.app.vault.getAbstractFileByPath(current);
            if (existing instanceof TFolder) {
                folder = existing;
            } else if (existing) {
                throw new Error(`"${current}" exists and is not a folder`);
            } else {
                folder = await this.app.vault.createFolder(current);
            }
        }
        return folder;
    }

    /**
     * Handle creating a new folder from the text typed in the modal
     */
    private async handleCreateFolder(input: string): Promise<void> {
        const name = validateFolderName(input);
        if (!name.ok) {
            new Notice(`Can't create folder: ${name.reason}`);
            return;
        }

        const base = this.resolveCreateLocation();
        const fullPath = normalizePath(
            base ? `${base}/${name.path}` : name.path,
        );

        try {
            if (this.app.vault.getAbstractFileByPath(fullPath)) {
                new Notice(`Folder "${fullPath}" already exists`);
                return;
            }

            const newFolder = await this.createFolderRecursive(fullPath);
            new Notice(`Folder "${fullPath}" created successfully`);
            this.navigateTo(newFolder);
        } catch (error) {
            console.error("Folder Navigator: failed to create folder", error);
            new Notice(
                `Failed to create folder: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
