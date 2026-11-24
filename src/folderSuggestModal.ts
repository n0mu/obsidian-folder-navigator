import {
    type App,
    Notice,
    SuggestModal,
    TFolder,
    type View,
    normalizePath,
    renderMatches,
} from "obsidian";
import type FolderNavigatorPlugin from "./main";
import { FolderDisplayMode } from "./settings";
import { pinnedFolders, searchFolders, shouldOfferCreate } from "./search";
import { validateFolderName } from "./paths";

// Helper function for conditional logging based on plugin settings
function log(
    message: string,
    plugin: FolderNavigatorPlugin,
    ...args: unknown[]
): void {
    if (plugin.settings.debugMode) {
        console.log(message, ...args);
    }
}

// Helper function for error logging (always show errors)
function logError(message: string, ...args: unknown[]): void {
    console.error(message, ...args);
}

interface FileExplorerView extends View {
    fileItems: Record<string, any>;
    expandFolder?: (folder: TFolder) => void; // Optional: may not exist in all versions
}

interface FileExplorerInstance {
    view: FileExplorerView;
    revealInFolder: (file: any) => void;
}

interface InternalPlugins {
    plugins: {
        "file-explorer": {
            instance: FileExplorerInstance;
        };
    };
}

interface ExtendedApp extends App {
    internalPlugins: InternalPlugins;
}

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
            this.close();
            setTimeout(() => {
                void this.navigateToFolder(item.folder);
            }, 100);
        }
    }

    /**
     * Get all parent folders of a given folder in order from root to leaf
     */
    private getParentFolderChain(folder: TFolder): TFolder[] {
        const parentChain: TFolder[] = [];
        let currentFolder: TFolder | null = folder.parent;

        while (currentFolder) {
            parentChain.unshift(currentFolder); // Add at beginning to get root->leaf order
            currentFolder = currentFolder.parent;
        }

        return parentChain;
    }

    /**
     * Get the file explorer instance from Obsidian's internal APIs
     */
    private getFileExplorer(): FileExplorerInstance | null {
        try {
            const app = this.app as ExtendedApp;

            if (!app.internalPlugins?.plugins["file-explorer"]?.instance) {
                logError("Could not find file explorer plugin instance");
                return null;
            }

            const fileExplorer =
                app.internalPlugins.plugins["file-explorer"].instance;

            if (typeof fileExplorer.revealInFolder !== "function") {
                logError(
                    "revealInFolder method not found on file explorer instance",
                );
                return null;
            }

            // Log available methods for debugging
            if (this.plugin.settings.debugMode) {
                log("File explorer instance methods:", this.plugin);
                const methods = Object.getOwnPropertyNames(
                    Object.getPrototypeOf(fileExplorer),
                );
                log(methods.join(", "), this.plugin);

                if (fileExplorer.view) {
                    log("File explorer view methods:", this.plugin);
                    const viewMethods = Object.getOwnPropertyNames(
                        Object.getPrototypeOf(fileExplorer.view),
                    );
                    log(viewMethods.join(", "), this.plugin);
                }
            }

            return fileExplorer;
        } catch (error) {
            logError("Error accessing file explorer:", error);
            return null;
        }
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
        log(`Creating new folder: "${fullPath}"`, this.plugin);

        try {
            if (this.app.vault.getAbstractFileByPath(fullPath)) {
                new Notice(`Folder "${fullPath}" already exists`);
                return;
            }

            const newFolder = await this.createFolderRecursive(fullPath);
            new Notice(`Folder "${fullPath}" created successfully`);

            this.close();

            // Navigate to the newly created folder
            setTimeout(() => {
                void this.navigateToFolder(newFolder);
            }, 100);
        } catch (error) {
            logError("Error creating folder:", error);
            new Notice(
                `Failed to create folder: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Navigate to a folder (same logic as in onChooseItem)
     */
    private async navigateToFolder(folder: TFolder): Promise<void> {
        try {
            this.plugin.recordFolderVisit(folder);

            // Make sure the file explorer is visible
            const fileExplorerLeaves =
                this.app.workspace.getLeavesOfType("file-explorer");
            if (fileExplorerLeaves.length === 0) {
                logError("No file explorer leaf found");
                return;
            }

            const fileExplorerLeaf = fileExplorerLeaves[0];
            await this.app.workspace.revealLeaf(fileExplorerLeaf);
            log("File explorer leaf revealed", this.plugin);

            // Get the file explorer instance
            const fileExplorer = this.getFileExplorer();
            if (!fileExplorer) {
                logError("Failed to get file explorer instance");
                return;
            }

            // Step 1: Reveal the folder in the file explorer
            log(`Revealing folder in explorer: "${folder.path}"`, this.plugin);
            fileExplorer.revealInFolder(folder);

            // Step 2: Wait a bit for the UI to update, then expand folders using DOM
            setTimeout(() => {
                if (this.plugin.settings.expandTargetFolder) {
                    // Get all parent folders in order
                    log(
                        `Expanding parent folders for: "${folder.path}"`,
                        this.plugin,
                    );
                    const parentFolders = this.getParentFolderChain(folder);
                    log(
                        `Parent chain: ${parentFolders.map((f) => f.name).join(" -> ")}`,
                        this.plugin,
                    );

                    // First, expand all parent folders in order from root to leaf
                    parentFolders.forEach((parentFolder, index) => {
                        // Use increasing delays to ensure proper sequence
                        setTimeout(() => {
                            this.expandFolderByDOMClick(parentFolder.name);
                        }, index * 50);
                    });

                    // Then expand the target folder itself (after parents are expanded)
                    setTimeout(
                        () => {
                            log(
                                `Expanding target folder: "${folder.name}"`,
                                this.plugin,
                            );
                            this.expandFolderByDOMClick(folder.name);

                            // Highlight the folder after expansion
                            setTimeout(() => {
                                this.highlightFolderInDOM(folder.name);
                            }, 200);
                        },
                        parentFolders.length * 50 + 100,
                    );
                } else {
                    // Just highlight the folder if we're not expanding
                    setTimeout(() => {
                        this.highlightFolderInDOM(folder.name);
                    }, 200);
                }
            }, 100);
        } catch (error) {
            logError("Error in folder navigation:", error);
        }
    }

    /**
     * Expand a folder by finding and clicking its title directly in the DOM
     */
    private expandFolderByDOMClick(folderName: string): void {
        try {
            log(`Looking for folder to expand: "${folderName}"`, this.plugin);

            // Find all folder title content elements
            const allTitleContents = document.querySelectorAll(
                ".nav-folder-title-content",
            );

            for (const titleContent of Array.from(allTitleContents)) {
                if (titleContent.textContent === folderName) {
                    log(
                        `Found folder title content: "${folderName}"`,
                        this.plugin,
                    );

                    // Get the title element
                    const titleElement =
                        titleContent.closest(".nav-folder-title");
                    if (!(titleElement instanceof HTMLElement)) {
                        log(
                            `Could not find title element for: "${folderName}"`,
                            this.plugin,
                        );
                        continue;
                    }

                    // Get the folder element
                    const folderElement = titleContent.closest(".nav-folder");
                    if (!(folderElement instanceof HTMLElement)) {
                        log(
                            `Could not find folder element for: "${folderName}"`,
                            this.plugin,
                        );
                        continue;
                    }

                    // Check if it's collapsed
                    if (folderElement.classList.contains("is-collapsed")) {
                        log(
                            `Folder is collapsed, clicking title to expand: "${folderName}"`,
                            this.plugin,
                        );
                        // Click the title element directly - this is more reliable than the collapse indicator
                        titleElement.click();
                        return;
                    } else {
                        log(
                            `Folder already expanded: "${folderName}"`,
                            this.plugin,
                        );
                        return;
                    }
                }
            }

            log(
                `Could not find folder with name: "${folderName}"`,
                this.plugin,
            );
        } catch (error) {
            logError("Error expanding folder:", error);
        }
    }

    /**
     * Highlight a folder in the DOM by finding and styling its title
     */
    private highlightFolderInDOM(folderName: string): void {
        try {
            log(
                `Looking for folder to highlight: "${folderName}"`,
                this.plugin,
            );

            // Find all folder title content elements
            const allTitleContents = document.querySelectorAll(
                ".nav-folder-title-content",
            );

            for (const titleContent of Array.from(allTitleContents)) {
                if (titleContent.textContent === folderName) {
                    log(
                        `Found folder to highlight: "${folderName}"`,
                        this.plugin,
                    );

                    // Get the title element
                    const titleElement =
                        titleContent.closest(".nav-folder-title");
                    if (!(titleElement instanceof HTMLElement)) {
                        continue;
                    }

                    // Scroll into view
                    titleElement.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                    });

                    // Add highlighting class
                    titleElement.classList.add("fn-highlighted");

                    // Remove after delay
                    setTimeout(() => {
                        titleElement.classList.remove("fn-highlighted");
                    }, 2000);

                    return;
                }
            }

            log(
                `Could not find folder to highlight: "${folderName}"`,
                this.plugin,
            );
        } catch (error) {
            logError("Error highlighting folder:", error);
        }
    }
}
