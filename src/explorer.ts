// Revealing a folder in the core file explorer.
//
// Obsidian has no public API for this. The only private member used is the
// file-explorer view's `revealInFolder(file)`, which expands the folder's
// ancestors, focuses it and scrolls it into view. It is feature-checked
// before use; everything else goes through public workspace APIs and the
// explorer's own DOM (scoped to its leaf, matched by `data-path`).
import { Notice, type App, type TFolder, type View } from "obsidian";

interface RevealableView extends View {
    revealInFolder(file: TFolder): void;
}

function canReveal(view: View): view is RevealableView {
    return (
        typeof (view as Partial<RevealableView>).revealInFolder === "function"
    );
}

const EXPLORER_VIEW_TYPE = "file-explorer";
const HIGHLIGHT_CLASS = "fn-highlighted";
const HIGHLIGHT_MS = 2000;
/** How many frames to wait for the explorer to render the revealed row. */
const MAX_WAIT_FRAMES = 30;

function nextFrame(win: Window): Promise<void> {
    return new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
}

export class FolderRevealer {
    private app: App;
    /** Bumped on every reveal and on cancel, so stale work stops early. */
    private generation = 0;
    private highlighted: { el: HTMLElement; timer: number } | null = null;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Show `folder` in the file explorer, expand it if `expand` is set, and
     * highlight it briefly. Reports problems with a Notice; never throws.
     */
    async reveal(folder: TFolder, expand: boolean): Promise<void> {
        const generation = ++this.generation;
        this.clearHighlight();
        try {
            const leaf =
                this.app.workspace.getLeavesOfType(EXPLORER_VIEW_TYPE)[0];
            if (!leaf) {
                new Notice(
                    "Folder Navigator: open the file explorer (Files core plugin) to reveal folders.",
                );
                return;
            }
            await this.app.workspace.revealLeaf(leaf); // also loads a deferred view
            if (generation !== this.generation) return;

            const { view } = leaf;
            if (!canReveal(view)) {
                new Notice(
                    "Folder Navigator: this version of the file explorer can't reveal folders.",
                );
                return;
            }
            view.revealInFolder(folder);

            const title = await this.findTitle(view.containerEl, folder.path);
            if (!title || generation !== this.generation) return;

            if (
                expand &&
                title.closest(".nav-folder")?.classList.contains("is-collapsed")
            ) {
                title.click(); // the explorer toggles a folder on title click
            }
            this.highlight(title);
        } catch (error) {
            console.error("Folder Navigator: failed to reveal folder", error);
            new Notice(`Folder Navigator: couldn't reveal "${folder.path}".`);
        }
    }

    /** Stop pending work and remove any highlight (e.g. on plugin unload). */
    cancel(): void {
        this.generation++;
        this.clearHighlight();
    }

    /** The folder's title row in this explorer, once it has been rendered. */
    private async findTitle(
        container: HTMLElement,
        path: string,
    ): Promise<HTMLElement | null> {
        const selector = `.nav-folder-title[data-path="${CSS.escape(path)}"]`;
        const generation = this.generation;
        for (let i = 0; i < MAX_WAIT_FRAMES; i++) {
            const el = container.querySelector(selector);
            if (el?.instanceOf(HTMLElement)) return el;
            await nextFrame(container.win);
            if (generation !== this.generation) return null;
        }
        return null;
    }

    private highlight(el: HTMLElement): void {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.addClass(HIGHLIGHT_CLASS);
        const timer = el.win.setTimeout(
            () => this.clearHighlight(),
            HIGHLIGHT_MS,
        );
        this.highlighted = { el, timer };
    }

    private clearHighlight(): void {
        if (!this.highlighted) return;
        const { el, timer } = this.highlighted;
        el.win.clearTimeout(timer);
        el.removeClass(HIGHLIGHT_CLASS);
        this.highlighted = null;
    }
}
