// Drives a real, isolated Obsidian instance for end-to-end tests.
//
// Each run gets a temporary vault and a temporary Electron user-data dir, so
// it never touches the user's own Obsidian profile or vaults, and can run
// while the user's Obsidian is open. Control is over the Chrome DevTools
// Protocol: `evaluate()` runs a function inside the Obsidian window, and
// `typeText` / `press` / `click` send real input events.
//
// Functions passed to `evaluate` / `waitFor` are serialised with
// `toString()` and run in the renderer: they must not use anything from
// their surrounding Node scope. Pass values through `args` instead.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { App } from "obsidian";
import type FolderNavigatorPlugin from "../src/main.ts";
import { Cdp } from "./cdp.ts";

export const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = JSON.parse(
    readFileSync(join(ROOT, "manifest.json"), "utf8"),
) as { id: string };
export const PLUGIN_ID = MANIFEST.id;
export const COMMAND_ID = `${PLUGIN_ID}:open-folder-navigator`;

export function obsidianBinary(): string {
    if (process.env.OBSIDIAN_BIN) return process.env.OBSIDIAN_BIN;
    if (process.platform === "darwin") {
        return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
    }
    if (process.platform === "win32") {
        return join(
            process.env.LOCALAPPDATA ?? "",
            "Programs/Obsidian/Obsidian.exe",
        );
    }
    return "/usr/bin/obsidian";
}

/** The private parts of `App` the tests reach into. */
export interface TestApp extends App {
    plugins: {
        plugins: Record<string, unknown>;
        isEnabled(): boolean;
        setEnable(enabled: boolean): Promise<void>;
        enablePluginAndSave(id: string): Promise<void>;
        enablePlugin(id: string): Promise<void>;
        disablePlugin(id: string): Promise<void>;
    };
    internalPlugins: {
        getPluginById(id: string): {
            enabled: boolean;
            enable(save: boolean): Promise<void> | void;
            disable(save: boolean): void;
        } | null;
    };
    commands: {
        commands: Record<string, unknown>;
        executeCommandById(id: string): boolean;
    };
    setting: {
        open(): void;
        close(): void;
        openTabById(id: string): void;
        modalEl: HTMLElement;
        activeTab: { id: string; containerEl: HTMLElement } | null;
    };
    emulateMobile(on: boolean): void;
    isMobile: boolean;
}

export interface Ctx {
    app: TestApp;
    plugin: FolderNavigatorPlugin;
}

export interface Row {
    kind: "folder" | "separator" | "create";
    text: string;
    highlights: string[];
}

interface EvalResult {
    result: { value?: unknown };
    exceptionDetails?: {
        text: string;
        exception?: { description?: string };
    };
}

interface ExceptionEvent {
    exceptionDetails: {
        text: string;
        url?: string;
        exception?: { description?: string };
    };
}

interface ConsoleEvent {
    type: string;
    args: Array<{ value?: unknown; description?: string }>;
}

const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 } as const;

export class Obsidian {
    /** Uncaught exceptions and console.error calls seen in the window. */
    readonly errors: string[] = [];

    readonly vault: string;
    private readonly tmp: string;
    private readonly proc: ChildProcess;
    private readonly cdp: Cdp;

    private constructor(
        vault: string,
        tmp: string,
        proc: ChildProcess,
        cdp: Cdp,
    ) {
        this.vault = vault;
        this.tmp = tmp;
        this.proc = proc;
        this.cdp = cdp;
        cdp.on<ExceptionEvent>(
            "Runtime.exceptionThrown",
            ({ exceptionDetails: d }) => {
                this.errors.push(
                    `${d.exception?.description ?? d.text} @ ${d.url ?? "?"}`,
                );
            },
        );
        cdp.on<ConsoleEvent>("Runtime.consoleAPICalled", ({ type, args }) => {
            if (type === "error") {
                this.errors.push(
                    args.map((a) => a.description ?? String(a.value)).join(" "),
                );
            }
        });
    }

    /** Create a vault with `folders`, install the built plugin, launch Obsidian. */
    static async launch(folders: readonly string[]): Promise<Obsidian> {
        const bin = obsidianBinary();
        if (!existsSync(bin)) throw new Error(`Obsidian not found at ${bin}`);
        for (const f of ["main.js", "manifest.json", "styles.css"]) {
            if (!existsSync(join(ROOT, "build", f))) {
                throw new Error(`build/${f} missing: run \`npm run build\``);
            }
        }

        const tmp = mkdtempSync(join(tmpdir(), "fn-e2e-"));
        const vault = join(tmp, "vault");
        const userData = join(tmp, "user-data");
        for (const f of folders) mkdirSync(join(vault, f), { recursive: true });
        const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
        mkdirSync(pluginDir, { recursive: true });
        for (const f of ["main.js", "manifest.json", "styles.css"]) {
            cpSync(join(ROOT, "build", f), join(pluginDir, f));
        }
        writeFileSync(
            join(vault, ".obsidian", "community-plugins.json"),
            JSON.stringify([PLUGIN_ID]),
        );
        mkdirSync(userData);
        writeFileSync(
            join(userData, "obsidian.json"),
            JSON.stringify({
                vaults: {
                    fne2e00000000001: {
                        path: vault,
                        ts: Date.now(),
                        open: true,
                    },
                },
            }),
        );

        const args = [
            `--user-data-dir=${userData}`,
            "--remote-debugging-port=0",
        ];
        if (process.platform === "linux") args.push("--no-sandbox");
        const proc = spawn(bin, args, { stdio: "ignore" });
        try {
            return await Obsidian.connect(vault, tmp, userData, proc);
        } catch (error) {
            // Don't leave a stray Obsidian keeping the test process alive.
            proc.kill("SIGKILL");
            if (!process.env.FN_E2E_KEEP)
                rmSync(tmp, { recursive: true, force: true });
            throw error;
        }
    }

    private static async connect(
        vault: string,
        tmp: string,
        userData: string,
        proc: ChildProcess,
    ): Promise<Obsidian> {
        const portFile = join(userData, "DevToolsActivePort");
        const port = await poll(30_000, "DevTools port", () =>
            existsSync(portFile)
                ? readFileSync(portFile, "utf8").split("\n")[0]
                : undefined,
        );
        const pageUrl = await poll(30_000, "Obsidian window", async () => {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = (await res.json()) as Array<{
                type: string;
                url: string;
                webSocketDebuggerUrl: string;
            }>;
            return targets.find(
                (t) =>
                    t.type === "page" &&
                    t.url.startsWith("app://obsidian.md/index.html"),
            )?.webSocketDebuggerUrl;
        });
        const cdp = await Cdp.connect(pageUrl);
        await cdp.send("Runtime.enable");
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

        const ob = new Obsidian(vault, tmp, proc, cdp);
        await ob.afterLoad(true);
        return ob;
    }

    /** Wait for the workspace, turn community plugins on, record notices. */
    private async afterLoad(enablePlugins: boolean): Promise<void> {
        await this.waitFor(
            ({ app }) => app?.workspace?.layoutReady,
            [],
            30_000,
        );
        if (enablePlugins) {
            // A vault that ships community plugins asks whether to trust it.
            // Answer like a user would; fall back to the API if it never shows.
            // Never call the API as well: while the dialog-triggered load is
            // still in onload, plugins[id] is unset and a second instance
            // would load and leak.
            let clicked = false;
            const deadline = Date.now() + 5000;
            while (!clicked && Date.now() < deadline) {
                clicked = await this.evaluate(() => {
                    const button = Array.from(
                        document.querySelectorAll<HTMLButtonElement>(
                            ".mod-trust-folder button",
                        ),
                    ).find(
                        (b) =>
                            b.textContent === "Trust author and enable plugins",
                    );
                    button?.click();
                    return button !== undefined;
                });
                if (!clicked) await sleep(100);
            }
            if (!clicked) {
                await this.evaluate(async ({ app }, id) => {
                    await app.plugins.setEnable(true);
                    await app.plugins.enablePluginAndSave(id);
                }, PLUGIN_ID);
            }
        }
        await this.waitFor(({ plugin }) => plugin !== undefined, [], 10_000);
        await this.evaluate(() => {
            const w = window as unknown as { __fnNotices: string[] };
            w.__fnNotices = [];
            new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const n of Array.from(m.addedNodes)) {
                        if (
                            n instanceof HTMLElement &&
                            n.classList.contains("notice")
                        ) {
                            w.__fnNotices.push(n.textContent ?? "");
                        }
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        });
    }

    async close(): Promise<void> {
        this.cdp.close();
        const exited = new Promise((r) => this.proc.once("exit", r));
        this.proc.kill();
        await Promise.race([exited, sleep(5000)]);
        if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
        if (!process.env.FN_E2E_KEEP) {
            rmSync(this.tmp, { recursive: true, force: true });
        }
    }

    // ---- evaluation -------------------------------------------------------

    async evaluate<A extends unknown[], R>(
        fn: (ctx: Ctx, ...args: A) => R,
        ...args: A
    ): Promise<Awaited<R>> {
        const expression = `(async () => {
            const app = window.app;
            const ctx = { app, plugin: app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}] };
            return await (${fn.toString()})(ctx, ...${JSON.stringify(args)});
        })()`;
        const res = await this.cdp.send<EvalResult>("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            const d = res.exceptionDetails;
            throw new Error(d.exception?.description ?? d.text);
        }
        return res.result.value as Awaited<R>;
    }

    /** Poll `fn` in the window until it returns a truthy value. */
    async waitFor<A extends unknown[], R>(
        fn: (ctx: Ctx, ...args: A) => R,
        args: A,
        timeoutMs = 5000,
    ): Promise<Awaited<R>> {
        let last: unknown;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const value = await this.evaluate(fn, ...args);
                if (value) return value;
                last = value;
            } catch (error) {
                last = error;
            }
            await sleep(50);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs} ms: ${fn.toString().slice(0, 200)}\nlast: ${String(last)}`,
        );
    }

    // ---- input ------------------------------------------------------------

    async typeText(text: string): Promise<void> {
        await this.cdp.send("Input.insertText", { text });
    }

    async press(key: keyof typeof KEYS): Promise<void> {
        const code = KEYS[key];
        const base = {
            key,
            code: key,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode: code,
        };
        await this.cdp.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            ...base,
        });
        if (key === "Enter") {
            await this.cdp.send("Input.dispatchKeyEvent", {
                type: "char",
                text: "\r",
                ...base,
            });
        }
        await this.cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            ...base,
        });
    }

    /** Click the `index`-th element matching `selector` (optionally with exact text). */
    async click(
        selector: string,
        opts: { index?: number; text?: string } = {},
    ): Promise<void> {
        const point = await this.evaluate(
            (_ctx, sel, index, text) => {
                const matches = Array.from(
                    document.querySelectorAll<HTMLElement>(sel),
                ).filter(
                    (el) => text === null || el.textContent?.trim() === text,
                );
                const el = matches[index];
                if (!el) return null;
                el.scrollIntoView({ block: "center" });
                const r = el.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            },
            selector,
            opts.index ?? 0,
            opts.text ?? null,
        );
        if (!point)
            throw new Error(
                `nothing to click: ${selector} ${JSON.stringify(opts)}`,
            );
        for (const type of ["mousePressed", "mouseReleased"]) {
            await this.cdp.send("Input.dispatchMouseEvent", {
                type,
                x: point.x,
                y: point.y,
                button: "left",
                clickCount: 1,
            });
        }
    }

    // ---- app state ----------------------------------------------------------

    /** Reload the window (e.g. after `emulateMobile`) and wait for it. */
    async reloadWindow(trigger: (ctx: Ctx) => void): Promise<void> {
        await this.evaluate(() => {
            (
                window as unknown as { __fnBeforeReload: boolean }
            ).__fnBeforeReload = true;
        });
        await this.evaluate(trigger).catch(() => undefined); // the reload may cut it off
        await this.waitFor(
            () =>
                !(window as unknown as { __fnBeforeReload?: boolean })
                    .__fnBeforeReload,
            [],
            30_000,
        );
        await this.afterLoad(false);
    }

    get pluginDir(): string {
        return join(this.vault, ".obsidian", "plugins", PLUGIN_ID);
    }

    readData(): Record<string, unknown> | null {
        const file = join(this.pluginDir, "data.json");
        try {
            return JSON.parse(readFileSync(file, "utf8")) as Record<
                string,
                unknown
            >;
        } catch {
            return null; // missing, or caught mid-write
        }
    }

    /** Replace data.json (or delete it with `null`) and reload the plugin. */
    async resetPlugin(data: object | null = {}): Promise<void> {
        await this.closeModals();
        const file = join(this.pluginDir, "data.json");
        await this.evaluate(
            ({ app }, id) => app.plugins.disablePlugin(id),
            PLUGIN_ID,
        );
        if (data === null) rmSync(file, { force: true });
        else writeFileSync(file, JSON.stringify(data));
        await this.evaluate(
            ({ app }, id) => app.plugins.enablePlugin(id),
            PLUGIN_ID,
        );
        await this.waitFor(({ plugin }) => plugin?.settings !== undefined, []);
        await this.takeNotices();
    }

    /** Swap in another main.js (e.g. an old build) and reload the plugin. */
    async installMainJs(code: string): Promise<void> {
        writeFileSync(join(this.pluginDir, "main.js"), code);
        await this.resetPlugin(this.readData() ?? {});
    }

    async takeNotices(): Promise<string[]> {
        return this.evaluate(({ app }) => {
            const w = window as unknown as { __fnNotices: string[] };
            const notices = w.__fnNotices;
            w.__fnNotices = [];
            // Notices shown from another window (e.g. settings) live there.
            const other = app.setting.modalEl.ownerDocument;
            if (other !== document) {
                for (const n of Array.from(other.querySelectorAll(".notice"))) {
                    notices.push(n.textContent ?? "");
                }
            }
            return notices;
        });
    }

    async waitForNotice(pattern: RegExp, timeoutMs = 5000): Promise<string> {
        const seen: string[] = [];
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            seen.push(...(await this.takeNotices()));
            const hit = seen.find((n) => pattern.test(n));
            if (hit !== undefined) return hit;
            await sleep(50);
        }
        throw new Error(
            `no notice matching ${pattern}; saw ${JSON.stringify(seen)}`,
        );
    }

    /** Close the settings window and every modal in every window. */
    async closeModals(): Promise<void> {
        await this.evaluate(({ app }) => app.setting.close());
        for (let i = 0; i < 5; i++) {
            const open = await this.evaluate(({ app }) => {
                const docs = new Set<Document>([document]);
                app.workspace.iterateAllLeaves((l) => {
                    docs.add(l.view.containerEl.ownerDocument);
                });
                let n = 0;
                for (const d of docs) {
                    const bg = d.querySelector<HTMLElement>(
                        ".modal-container:last-of-type .modal-bg",
                    );
                    if (bg) {
                        bg.click();
                        n++;
                    }
                }
                return n;
            });
            if (open === 0) return;
            await sleep(100);
        }
    }

    /**
     * Click (DOM event) the element matching `selector` with exact `text`, in
     * whichever window has it: the main window, the settings window or a
     * popout. CDP input only reaches the main window.
     */
    async domClick(selector: string, text: string): Promise<void> {
        await this.waitFor(
            ({ app }, sel, t) => {
                const docs = new Set<Document>([
                    document,
                    app.setting.modalEl.ownerDocument,
                ]);
                app.workspace.iterateAllLeaves((l) => {
                    docs.add(l.view.containerEl.ownerDocument);
                });
                for (const d of docs) {
                    const el = Array.from(
                        d.querySelectorAll<HTMLElement>(sel),
                    ).find(
                        (e) =>
                            e.textContent?.trim() === t ||
                            e.getAttribute("aria-label") === t,
                    );
                    if (el) {
                        el.click();
                        return true;
                    }
                }
                return false;
            },
            [selector, text],
        );
    }

    // ---- folder navigator modal --------------------------------------------

    async openNavigator(): Promise<void> {
        await this.closeModals();
        await this.evaluate(
            ({ app }, id) => app.commands.executeCommandById(id),
            COMMAND_ID,
        );
        await this.waitFor(
            () => document.querySelector(".prompt-input") !== null,
            [],
        );
    }

    /** Replace the modal's query with `text`, typed as real input. */
    async query(text: string): Promise<Row[]> {
        await this.evaluate(() => {
            const input =
                document.querySelector<HTMLInputElement>(".prompt-input");
            if (!input) throw new Error("no prompt open");
            input.focus();
            input.select();
        });
        if (text === "") {
            await this.evaluate(() => {
                const input =
                    document.querySelector<HTMLInputElement>(".prompt-input");
                if (input) {
                    input.value = "";
                    input.dispatchEvent(new Event("input"));
                }
            });
        } else {
            await this.typeText(text);
        }
        return this.rows();
    }

    async rows(): Promise<Row[]> {
        return this.evaluate(() =>
            Array.from(
                document.querySelectorAll(".prompt-results .suggestion-item"),
            ).map((el): Row => ({
                kind: el.querySelector(".fn-separator, .folder-separator")
                    ? "separator"
                    : el.querySelector(
                            ".fn-create-option, .folder-create-option",
                        )
                      ? "create"
                      : "folder",
                text: el.textContent?.trim() ?? "",
                highlights: Array.from(
                    el.querySelectorAll(".suggestion-highlight"),
                ).map((h) => h.textContent ?? ""),
            })),
        );
    }

    async modalOpen(): Promise<boolean> {
        return this.evaluate(
            () => document.querySelector(".prompt-input") !== null,
        );
    }

    /** Click the suggestion row with this exact text. */
    async chooseRow(text: string): Promise<void> {
        await this.click(".prompt-results .suggestion-item", { text });
    }

    /** Open the modal, type `query`, choose the row `row` (default: `query`). */
    async navigate(query: string, row = query): Promise<void> {
        await this.openNavigator();
        await this.query(query);
        await this.chooseRow(row);
    }

    // ---- file explorer ------------------------------------------------------

    async explorerRow(path: string): Promise<{
        highlighted: boolean;
        collapsed: boolean;
        shown: boolean;
    } | null> {
        return this.evaluate(({ app }, p) => {
            const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
            const el = leaf?.view.containerEl.querySelector<HTMLElement>(
                `.nav-folder-title[data-path="${CSS.escape(p)}"]`,
            );
            if (!el) return null;
            return {
                highlighted: el.classList.contains("fn-highlighted"),
                collapsed:
                    el
                        .closest(".nav-folder")
                        ?.classList.contains("is-collapsed") ?? false,
                shown: el.offsetParent !== null,
            };
        }, path);
    }

    /** data-path of every highlighted element, in any window. */
    async highlightedPaths(): Promise<string[]> {
        return this.evaluate(({ app }) => {
            const docs = new Set<Document>([document]);
            app.workspace.iterateAllLeaves((leaf) => {
                docs.add(leaf.view.containerEl.ownerDocument);
            });
            return Array.from(docs).flatMap((d) =>
                Array.from(d.querySelectorAll(".fn-highlighted")).map(
                    (e) => e.getAttribute("data-path") ?? "?",
                ),
            );
        });
    }

    async waitForHighlight(path: string, timeoutMs = 5000): Promise<void> {
        await this.waitFor(
            (_ctx, p) =>
                document.querySelector(
                    `.fn-highlighted[data-path="${CSS.escape(p)}"]`,
                ) !== null,
            [path],
            timeoutMs,
        );
    }

    async collapseExplorer(): Promise<void> {
        await this.evaluate(({ app }) => {
            const view = app.workspace.getLeavesOfType("file-explorer")[0]
                ?.view as unknown as {
                tree: {
                    setCollapseAll(collapsed: boolean): void;
                    isAllCollapsed: boolean;
                };
            };
            view.tree.isAllCollapsed = false; // force a real collapse
            view.tree.setCollapseAll(true);
        });
    }

    /** Exactly one working file explorer, in an expanded left sidebar. */
    async ensureExplorer(): Promise<void> {
        await this.evaluate(async ({ app }) => {
            const core = app.internalPlugins.getPluginById("file-explorer");
            if (core && !core.enabled) await core.enable(false);
            const leaves = app.workspace.getLeavesOfType("file-explorer");
            for (const l of leaves) await l.loadIfDeferred();
            const working = leaves.filter(
                (l) =>
                    typeof (l.view as unknown as { revealInFolder?: unknown })
                        .revealInFolder === "function",
            );
            for (const l of leaves) if (l !== working[0]) l.detach();
            if (working.length === 0) {
                await app.workspace.ensureSideLeaf("file-explorer", "left", {
                    reveal: false,
                });
            }
            if (app.workspace.leftSplit.collapsed)
                app.workspace.leftSplit.expand();
        });
    }

    async folderExists(path: string): Promise<boolean> {
        return this.evaluate(
            ({ app }, p) => app.vault.getFolderByPath(p) !== null,
            path,
        );
    }

    async history(): Promise<
        Record<string, { lastAccessed: number; accessCount: number }>
    > {
        return this.evaluate(({ plugin }) => ({
            ...plugin.settings.folderHistory,
        }));
    }
}

async function poll<T>(
    timeoutMs: number,
    what: string,
    fn: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const v = await fn();
            if (v) return v;
        } catch {
            // not ready yet
        }
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** Build the plugin as it was at git `ref` (for old-vs-new comparisons). */
export async function buildAtRef(ref: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fn-ref-"));
    try {
        const files = execFileSync(
            "git",
            ["ls-tree", "-r", "--name-only", ref, "src"],
            {
                cwd: ROOT,
                encoding: "utf8",
            },
        )
            .split("\n")
            .filter(Boolean);
        for (const f of files) {
            const out = join(dir, f);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(
                out,
                execFileSync("git", ["show", `${ref}:${f}`], { cwd: ROOT }),
            );
        }
        const esbuild = await import("esbuild");
        const result = await esbuild.build({
            entryPoints: [join(dir, "src", "main.ts")],
            bundle: true,
            format: "cjs",
            target: "es2018",
            external: ["obsidian"],
            write: false,
            logLevel: "silent",
        });
        return result.outputFiles[0].text;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
