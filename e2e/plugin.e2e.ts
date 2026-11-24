// End-to-end tests in a real Obsidian window. Covers the manual checklist in
// handoff.md §6 plus the S1–S4 leftovers. Run with `npm run test:e2e`.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildAtRef, Obsidian, obsidianBinary, type Row } from "./obsidian.ts";

const FOLDERS = [
    "A/notes",
    "B/notes",
    "deep/l1/l2/l3/l4/target/child",
    "foo/bar/baz",
    "abc/x",
    "abc/y/abc",
    "abcd",
    "Projects/Alpha",
    "constructor", // a folder named "__proto__" corrupts Obsidian's own file map, so it's tested via data.json
    "Inbox",
    "rename-me/sub",
    ...Array.from(
        { length: 12 },
        (_, i) => `proj-${String(i + 1).padStart(2, "0")}`,
    ),
];
const TARGET = "deep/l1/l2/l3/l4/target";
/** The v0.5.0 release commit, for the old-vs-new comparison. */
const OLD_REF = "4175b9d";

const folderTexts = (rows: Row[]) =>
    rows.filter((r) => r.kind === "folder").map((r) => r.text);
const kinds = (rows: Row[]) => rows.map((r) => r.kind);

function history(
    entries: Record<string, [lastAccessed: number, accessCount: number]>,
) {
    return Object.fromEntries(
        Object.entries(entries).map(([p, [lastAccessed, accessCount]]) => [
            p,
            { lastAccessed, accessCount },
        ]),
    );
}

const VISITED = history({ "B/notes": [3000, 1], "foo/bar": [2000, 5] });

async function waitForData(
    ob: Obsidian,
    check: (data: Record<string, unknown>) => boolean,
): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const data = ob.readData();
        if (data && check(data)) return;
        await sleep(50);
    }
    assert.fail(
        `data.json never matched; last: ${JSON.stringify(ob.readData())}`,
    );
}

const skip = existsSync(obsidianBinary())
    ? false
    : `Obsidian not found at ${obsidianBinary()}`;

describe("Folder Navigator in Obsidian", { skip, timeout: 300_000 }, () => {
    let ob: Obsidian;

    before(
        async () => {
            ob = await Obsidian.launch(FOLDERS);
        },
        { timeout: 90_000 },
    );

    after(async () => {
        await ob?.close();
    });

    test("S1: the built plugin loads and registers its command", async () => {
        const state = await ob.evaluate(({ app, plugin }) => ({
            loaded: plugin !== undefined,
            command:
                "folder-navigator:open-folder-navigator" in
                app.commands.commands,
        }));
        assert.deepEqual(state, { loaded: true, command: true });
    });

    test("reloading the plugin leaves exactly one settings tab and one instance", async () => {
        await ob.resetPlugin({});
        await ob.resetPlugin({});
        const tabs = await ob.evaluate(({ app, plugin }) => {
            const all = (
                app.setting as unknown as {
                    pluginTabs: Array<{ id: string; plugin: unknown }>;
                }
            ).pluginTabs;
            const ours = all.filter((t) => t.id === "folder-navigator");
            return {
                count: ours.length,
                current: ours.every((t) => t.plugin === plugin),
            };
        });
        assert.deepEqual(tabs, { count: 1, current: true });
    });

    describe("suggestion list (§6.1, §6.2, S3)", () => {
        test("empty query in default mode lists maxResults folders, no separators", async () => {
            await ob.resetPlugin({});
            await ob.openNavigator();
            const rows = await ob.rows();
            assert.equal(rows.length, 10);
            assert.ok(rows.every((r) => r.kind === "folder"));
        });

        test("recency mode pins recent folders between separators", async () => {
            await ob.resetPlugin({
                folderDisplayMode: "recency",
                folderHistory: VISITED,
            });
            await ob.openNavigator();
            const rows = await ob.rows();
            assert.deepEqual(
                rows.slice(0, 4).map((r) => r.text),
                [
                    "— Recently visited folders —",
                    "B/notes",
                    "foo/bar",
                    "— All folders —",
                ],
            );
            assert.deepEqual(kinds(rows.slice(0, 4)), [
                "separator",
                "folder",
                "folder",
                "separator",
            ]);
            assert.equal(
                rows.length,
                10,
                "separators count towards maxResults, as in v0.5.0",
            );
            const rest = folderTexts(rows.slice(4));
            assert.ok(
                !rest.includes("B/notes") && !rest.includes("foo/bar"),
                "pinned folders are not repeated",
            );
        });

        test("frequency mode orders the pinned block by visit count", async () => {
            await ob.resetPlugin({
                folderDisplayMode: "frequency",
                folderHistory: VISITED,
            });
            await ob.openNavigator();
            const rows = await ob.rows();
            assert.deepEqual(
                rows.slice(0, 4).map((r) => r.text),
                [
                    "— Frequently visited folders —",
                    "foo/bar",
                    "B/notes",
                    "— All folders —",
                ],
            );
        });

        test("separators can't be chosen by click or Enter", async () => {
            await ob.resetPlugin({
                folderDisplayMode: "recency",
                folderHistory: VISITED,
            });
            await ob.openNavigator();
            await ob.chooseRow("— Recently visited folders —");
            assert.equal(
                await ob.modalOpen(),
                true,
                "click on separator keeps the modal open",
            );
            const selected = () =>
                ob.evaluate(
                    () =>
                        document.querySelector(".suggestion-item.is-selected")
                            ?.textContent,
                );
            await ob.evaluate(() => {
                document
                    .querySelector<HTMLInputElement>(".prompt-input")
                    ?.focus();
            });
            await ob.press("ArrowDown");
            assert.equal(await selected(), "B/notes");
            await ob.press("ArrowUp");
            assert.equal(await selected(), "— Recently visited folders —");
            await ob.press("Enter");
            assert.equal(
                await ob.modalOpen(),
                true,
                "Enter on separator keeps the modal open",
            );
            await ob.press("ArrowDown");
            await ob.press("Enter");
            await ob.waitForHighlight("B/notes"); // and Enter on a folder navigates
        });

        test("keywords match in any order; a matching parent hides plain children", async () => {
            await ob.resetPlugin({});
            await ob.openNavigator();
            let rows = await ob.query("bar foo");
            assert.deepEqual(folderTexts(rows), ["foo/bar"]);
            rows = await ob.query("baz bar");
            assert.deepEqual(folderTexts(rows), ["foo/bar/baz"]);
            rows = await ob.query("abc");
            assert.deepEqual(folderTexts(rows), ["abc", "abc/y/abc", "abcd"]);
            assert.ok(
                !rows.some((r) => r.kind === "create"),
                "exact name match: no create row",
            );
        });

        test("search results contain no mode separators (QUAL-7)", async () => {
            await ob.resetPlugin({
                folderDisplayMode: "recency",
                folderHistory: VISITED,
            });
            await ob.openNavigator();
            const rows = await ob.query("notes");
            assert.deepEqual(
                rows.map((r) => r.text),
                ["B/notes", "A/notes"],
            );
        });

        test("matched text is highlighted once per range", async () => {
            await ob.resetPlugin({});
            await ob.openNavigator();
            let rows = await ob.query("alpha");
            assert.deepEqual(rows[0], {
                kind: "folder",
                text: "Projects/Alpha",
                highlights: ["Alpha"],
            });
            rows = await ob.query("abc bcd");
            assert.deepEqual(rows[0], {
                kind: "folder",
                text: "abcd",
                highlights: ["abcd"],
            });
        });

        test("the create row is shown even when there are maxResults matches", async () => {
            await ob.resetPlugin({});
            await ob.openNavigator();
            const rows = await ob.query("proj");
            assert.equal(folderTexts(rows).length, 10);
            assert.deepEqual(kinds(rows.slice(-2)), ["separator", "create"]);
            assert.equal(rows.at(-1)?.text, '➕ Create new folder: "proj"');
        });

        test("a blank query offers no create row", async () => {
            await ob.resetPlugin({});
            await ob.openNavigator();
            await ob.typeText("   ");
            const rows = await ob.rows();
            assert.ok(rows.every((r) => r.kind === "folder"));
        });
    });

    describe("navigation (§6.3, §6.4, S4)", () => {
        test("selecting a folder reveals it, expands it, highlights it ~2 s and records the visit", async () => {
            await ob.resetPlugin({});
            await ob.ensureExplorer();
            await ob.collapseExplorer();
            assert.equal((await ob.explorerRow("deep"))?.collapsed, true);
            await ob.navigate("target", TARGET);
            await ob.waitForHighlight(TARGET);
            assert.equal(await ob.modalOpen(), false);
            const row = await ob.explorerRow(TARGET);
            assert.equal(row?.shown, true, "ancestors were expanded");
            assert.equal(row?.collapsed, false, "target was expanded");
            assert.deepEqual(await ob.highlightedPaths(), [TARGET]);
            await waitForData(ob, (d) => TARGET in (d.folderHistory as object));
            await sleep(2300);
            assert.deepEqual(
                await ob.highlightedPaths(),
                [],
                "highlight removed after ~2 s",
            );
        });

        test("with expandTargetFolder off the target stays collapsed", async () => {
            await ob.resetPlugin({ expandTargetFolder: false });
            await ob.collapseExplorer();
            await ob.navigate("target", TARGET);
            await ob.waitForHighlight(TARGET);
            const row = await ob.explorerRow(TARGET);
            assert.equal(row?.shown, true);
            assert.equal(row?.collapsed, true);
        });

        test("with duplicate names the chosen folder is the one revealed", async () => {
            await ob.resetPlugin({});
            await ob.collapseExplorer();
            await ob.navigate("notes", "A/notes"); // make A/notes visible first
            await ob.waitForHighlight("A/notes");
            await ob.navigate("notes", "B/notes");
            await ob.waitForHighlight("B/notes");
            assert.deepEqual(await ob.highlightedPaths(), ["B/notes"]);
        });

        test("rapid navigation moves the highlight instead of stacking it", async () => {
            await ob.resetPlugin({});
            await ob.evaluate(async ({ app, plugin }) => {
                const a = app.vault.getFolderByPath("A/notes");
                const b = app.vault.getFolderByPath("B/notes");
                if (!a || !b) throw new Error("fixture missing");
                void plugin.revealer.reveal(a, true);
                await plugin.revealer.reveal(b, true);
            });
            assert.deepEqual(await ob.highlightedPaths(), ["B/notes"]);
        });

        test("a collapsed sidebar is opened", async () => {
            await ob.resetPlugin({});
            await ob.evaluate(({ app }) => app.workspace.leftSplit.collapse());
            await ob.navigate("notes", "A/notes");
            await ob.waitForHighlight("A/notes");
            assert.equal(
                await ob.evaluate(
                    ({ app }) => app.workspace.leftSplit.collapsed,
                ),
                false,
            );
        });

        test("works from a popout window", async () => {
            await ob.resetPlugin({});
            await ob.evaluate(async ({ app }) => {
                const leaf = app.workspace.openPopoutLeaf();
                await leaf.setViewState({ type: "empty" });
                app.workspace.setActiveLeaf(leaf, { focus: true });
            });
            const popoutCount = await ob.evaluate(({ app }) => {
                let n = 0;
                app.workspace.iterateAllLeaves((l) => {
                    if (l.view.containerEl.win !== window) n++;
                });
                return n;
            });
            assert.ok(popoutCount > 0, "popout opened");
            // Drive the modal inside the popout with DOM events (CDP input goes to the main window).
            await ob.evaluate(({ app }) =>
                app.commands.executeCommandById(
                    "folder-navigator:open-folder-navigator",
                ),
            );
            await ob.waitFor(({ app }) => {
                let found = false;
                app.workspace.iterateAllLeaves((l) => {
                    const w = l.view.containerEl.win;
                    if (
                        w !== window &&
                        w.document.querySelector(".prompt-input")
                    )
                        found = true;
                });
                return found;
            }, []);
            await ob.evaluate(({ app }) => {
                app.workspace.iterateAllLeaves((l) => {
                    const doc = l.view.containerEl.ownerDocument;
                    const input =
                        doc.querySelector<HTMLInputElement>(".prompt-input");
                    if (doc === document || !input) return;
                    input.value = "notes";
                    input.dispatchEvent(new Event("input"));
                    const row = Array.from(
                        doc.querySelectorAll<HTMLElement>(".suggestion-item"),
                    ).find((el) => el.textContent === "B/notes");
                    row?.click();
                });
            });
            await ob.waitForHighlight("B/notes");
            await ob.evaluate(({ app }) => {
                app.workspace.iterateAllLeaves((l) => {
                    if (l.view.containerEl.win !== window) l.detach();
                });
            });
        });

        test("explorer tab closed: Notice, no exception", async () => {
            await ob.resetPlugin({});
            await ob.evaluate(({ app }) => {
                app.workspace
                    .getLeavesOfType("file-explorer")
                    .forEach((l) => l.detach());
            });
            await ob.navigate("notes", "A/notes");
            await ob.waitForNotice(/file explorer isn't available/);
            await ob.ensureExplorer();
        });

        test("Files core plugin disabled (§6.7): Notice, no exception", async () => {
            await ob.resetPlugin({});
            await ob.evaluate(({ app }) =>
                app.internalPlugins
                    .getPluginById("file-explorer")
                    ?.disable(false),
            );
            await ob.navigate("notes", "A/notes");
            await ob.waitForNotice(/file explorer isn't available/);
            await ob.ensureExplorer();
            await ob.navigate("notes", "A/notes");
            await ob.waitForHighlight("A/notes");
        });
    });

    describe("creating folders (§6.5)", () => {
        test("plain and nested names are created and revealed", async () => {
            await ob.resetPlugin({});
            await ob.navigate(
                "Created One",
                '➕ Create new folder: "Created One"',
            );
            await ob.waitForNotice(/created successfully/);
            assert.equal(await ob.folderExists("Created One"), true);
            await ob.waitForHighlight("Created One");

            await ob.navigate("Nest/ed", '➕ Create new folder: "Nest/ed"');
            await ob.waitForNotice(/created successfully/);
            assert.equal(await ob.folderExists("Nest"), true);
            assert.equal(await ob.folderExists("Nest/ed"), true);
            await ob.waitForHighlight("Nest/ed");
        });

        test("invalid names are rejected with a Notice", async () => {
            await ob.resetPlugin({});
            for (const name of ["../x", "x:y", "a/./b", ".hidden"]) {
                await ob.navigate(name, `➕ Create new folder: "${name}"`);
                await ob.waitForNotice(/Can't create folder/);
            }
            assert.equal(await ob.folderExists("x"), false);
            assert.equal(
                existsSync(join(ob.vault, "..", "x")),
                false,
                "nothing written outside the vault",
            );
            assert.equal(await ob.folderExists("x:y"), false);
        });

        test("custom default location, then fallback to root once it's deleted", async () => {
            await ob.resetPlugin({ newFolderLocation: "Inbox" });
            await ob.navigate("Fresh", '➕ Create new folder: "Fresh"');
            await ob.waitForNotice(/created successfully/);
            assert.equal(await ob.folderExists("Inbox/Fresh"), true);

            await ob.evaluate(async ({ app }) => {
                const inbox = app.vault.getFolderByPath("Inbox");
                if (inbox) await app.vault.delete(inbox, true);
            });
            await ob.navigate("Fresh2", '➕ Create new folder: "Fresh2"');
            await ob.waitForNotice(/no longer exists/);
            await ob.waitFor(
                ({ app }) => app.vault.getFolderByPath("Fresh2") !== null,
                [],
            );
        });
    });

    describe("history (§6.6)", () => {
        test("renaming and deleting a visited folder keeps history in sync", async () => {
            await ob.resetPlugin({
                folderHistory: history({
                    "rename-me": [1000, 2],
                    "rename-me/sub": [2000, 1],
                }),
            });
            await ob.evaluate(async ({ app }) => {
                const f = app.vault.getFolderByPath("rename-me");
                if (f) await app.fileManager.renameFile(f, "renamed");
            });
            await waitForData(ob, (d) => {
                const h = d.folderHistory as Record<string, unknown>;
                return (
                    "renamed" in h && "renamed/sub" in h && !("rename-me" in h)
                );
            });
            await ob.evaluate(async ({ app }) => {
                const f = app.vault.getFolderByPath("renamed");
                if (f) await app.vault.delete(f, true);
            });
            await waitForData(
                ob,
                (d) => Object.keys(d.folderHistory as object).length === 0,
            );
        });

        test("history keys named constructor / __proto__ behave like any other", async () => {
            await ob.resetPlugin({ folderDisplayMode: "recency" });
            await ob.openNavigator();
            assert.equal(
                (await ob.rows())[0].kind,
                "folder",
                "nothing pinned without history",
            );

            // A synced or hand-edited data.json can hold any key. JSON.parse keeps
            // "__proto__" as an own property, as loadData() would.
            const data = JSON.parse(
                '{"folderDisplayMode":"recency","folderHistory":{' +
                    '"__proto__":{"lastAccessed":5000,"accessCount":3},' +
                    '"constructor":{"lastAccessed":4000,"accessCount":2}}}',
            ) as object;
            await ob.resetPlugin(data);
            const state = await ob.evaluate(({ plugin }) => ({
                keys: Object.keys(plugin.settings.folderHistory).sort(),
                nullProto:
                    Object.getPrototypeOf(plugin.settings.folderHistory) ===
                    null,
            }));
            assert.deepEqual(state, {
                keys: ["__proto__", "constructor"],
                nullProto: true,
            });

            await ob.openNavigator();
            const rows = await ob.rows();
            assert.deepEqual(
                rows.slice(0, 3).map((r) => r.text),
                [
                    "— Recently visited folders —",
                    "constructor",
                    "— All folders —",
                ],
                "only folders that exist are pinned",
            );

            await ob.navigate("constructor");
            await ob.waitForHighlight("constructor");
            await waitForData(ob, (d) => {
                const h = d.folderHistory as Record<
                    string,
                    { accessCount: number }
                >;
                return (
                    Object.prototype.hasOwnProperty.call(h, "__proto__") &&
                    Object.prototype.hasOwnProperty.call(h, "constructor") &&
                    (
                        Object.getOwnPropertyDescriptor(h, "constructor")
                            ?.value as { accessCount: number } | undefined
                    )?.accessCount === 3
                );
            });
        });
    });

    describe("settings (§6.8)", () => {
        // Settings open in their own window in Obsidian 1.15, so these use DOM
        // events (domClick) rather than CDP input.
        async function visibleSettings(): Promise<string[]> {
            return ob.evaluate(({ app }) =>
                Array.from(
                    app.setting.activeTab?.containerEl.querySelectorAll<HTMLElement>(
                        ".setting-item",
                    ) ?? [],
                )
                    .filter((el) => el.offsetParent !== null)
                    .map(
                        (el) =>
                            el.querySelector(".setting-item-name")
                                ?.textContent ?? "",
                    ),
            );
        }

        async function openSettings(): Promise<void> {
            await ob.closeModals();
            await ob.evaluate(({ app }) => {
                app.setting.open();
                app.setting.openTabById("folder-navigator");
            });
            await ob.waitFor(
                ({ app }) =>
                    app.setting.activeTab?.id === "folder-navigator" &&
                    app.setting.activeTab.containerEl.querySelector(
                        "select",
                    ) !== null,
                [],
            );
        }

        async function setMode(mode: string): Promise<void> {
            await ob.evaluate(({ app }, m) => {
                const select =
                    app.setting.activeTab?.containerEl.querySelector("select");
                if (!select) throw new Error("no dropdown");
                select.value = m;
                select.dispatchEvent(new Event("change"));
            }, mode);
            await sleep(100);
        }

        test("the mode dropdown shows the matching options and is saved", async () => {
            await ob.resetPlugin({});
            await openSettings();
            let names = await visibleSettings();
            assert.ok(names.includes("Maximum results"));
            assert.ok(!names.includes("Recent folders to show"));
            assert.ok(!names.includes("Frequent folders to show"));
            assert.ok(!names.includes("Reset folder history"));

            await setMode("recency");
            names = await visibleSettings();
            assert.ok(names.includes("Recent folders to show"));
            assert.ok(!names.includes("Frequent folders to show"));
            assert.ok(names.includes("Reset folder history"));

            await setMode("frequency");
            names = await visibleSettings();
            assert.ok(!names.includes("Recent folders to show"));
            assert.ok(names.includes("Frequent folders to show"));
            assert.ok(names.includes("Reset folder history"));
            assert.ok(!names.includes("Debug mode"), "debug mode removed (D3)");

            await waitForData(ob, (d) => d.folderDisplayMode === "frequency");
            await ob.resetPlugin(ob.readData());
            assert.equal(
                await ob.evaluate(
                    ({ plugin }) => plugin.settings.folderDisplayMode,
                ),
                "frequency",
            );
        });

        test("reset history asks first, then clears it", async () => {
            await ob.resetPlugin({
                folderDisplayMode: "recency",
                folderHistory: VISITED,
            });
            await openSettings();
            await ob.domClick("button", "Reset");
            await ob.domClick(".modal button", "Cancel");
            await sleep(100);
            assert.equal(
                Object.keys(await ob.history()).length,
                2,
                "cancel keeps history",
            );

            await ob.domClick("button", "Reset");
            await ob.domClick(".modal button", "Reset folder history");
            await ob.waitForNotice(/history has been reset/);
            assert.deepEqual(await ob.history(), {});
            await waitForData(
                ob,
                (d) => Object.keys(d.folderHistory as object).length === 0,
            );
        });

        test("the default location can be picked (vault root included) and reset", async () => {
            await ob.resetPlugin({});
            await openSettings();
            const pick = async (button: string, query: string, row: string) => {
                await ob.domClick("button", button);
                await ob.waitFor(
                    ({ app }, q) => {
                        const input =
                            app.setting.modalEl.ownerDocument.querySelector<HTMLInputElement>(
                                ".prompt-input",
                            );
                        if (!input) return false;
                        input.value = q;
                        input.dispatchEvent(new Event("input"));
                        return true;
                    },
                    [query],
                );
                await ob.domClick(".suggestion-item", row);
            };

            await pick("/ (Root)", "Projects", "Projects");
            await waitForData(ob, (d) => d.newFolderLocation === "Projects");
            await pick("Projects", "", "/ (Root)"); // S5: the root is selectable
            await waitForData(ob, (d) => d.newFolderLocation === "");
            await pick("/ (Root)", "Projects", "Projects");
            await waitForData(ob, (d) => d.newFolderLocation === "Projects");
            await ob.domClick(".clickable-icon", "Reset to root folder");
            await waitForData(ob, (d) => d.newFolderLocation === "");
        });

        test("the pre-1.13 display() path renders the same rows as the definitions", async () => {
            await ob.resetPlugin({});
            await ob.closeModals();
            const result = await ob.evaluate(({ plugin }) => {
                const tab = (
                    plugin as unknown as {
                        settingTab: {
                            containerEl: HTMLElement;
                            display(): void;
                            getSettingDefinitions(): Array<{
                                heading: string;
                                items: Array<{
                                    name: string;
                                    visible: boolean | (() => boolean);
                                }>;
                            }>;
                        };
                    }
                ).settingTab;
                const out: Record<
                    string,
                    { legacy: string[]; declarative: string[] }
                > = {};
                for (const mode of [
                    "default",
                    "recency",
                    "frequency",
                ] as const) {
                    plugin.settings.folderDisplayMode = mode;
                    tab.display();
                    out[mode] = {
                        legacy: Array.from(
                            tab.containerEl.querySelectorAll(
                                ".setting-item-name",
                            ),
                        ).map((e) => e.textContent ?? ""),
                        declarative: tab
                            .getSettingDefinitions()
                            .flatMap((g) => [
                                g.heading,
                                ...g.items
                                    .filter((i) =>
                                        typeof i.visible === "function"
                                            ? i.visible()
                                            : i.visible,
                                    )
                                    .map((i) => i.name),
                            ]),
                    };
                }
                plugin.settings.folderDisplayMode = "default";
                tab.containerEl.empty();
                return out;
            });
            for (const [mode, r] of Object.entries(result)) {
                assert.deepEqual(r.legacy, r.declarative, mode);
            }
            assert.ok(result.recency.legacy.includes("Recent folders to show"));
            assert.ok(
                result.frequency.legacy.includes("Frequent folders to show"),
            );
            assert.ok(!result.default.legacy.includes("Reset folder history"));
        });

        test("corrupted data.json falls back to defaults", async () => {
            await ob.resetPlugin({
                maxResults: "abc",
                folderHistory: null,
                folderDisplayMode: "bogus",
                recentFoldersToShow: 999,
                expandTargetFolder: "yes",
            });
            const s = await ob.evaluate(({ plugin }) => ({
                ...plugin.settings,
                folderHistory: { ...plugin.settings.folderHistory },
            }));
            assert.equal(s.maxResults, 10);
            assert.equal(s.folderDisplayMode, "default");
            assert.equal(s.recentFoldersToShow, 20);
            assert.equal(s.expandTargetFolder, true);
            assert.deepEqual(s.folderHistory, {});
            await ob.openNavigator();
            assert.equal((await ob.rows()).length, 10, "modal still works");
        });
    });

    describe(`same results as v0.5.0 (${OLD_REF})`, () => {
        const QUERIES = [
            "notes",
            "abc",
            "bar foo",
            "proj",
            "alpha",
            "l3",
            "a",
            "deep target",
            "o",
        ];

        interface Snapshot {
            browse: string[];
            search: Record<string, string[]>;
            pinned: Record<string, { pinned: string[]; rest: string[] }>;
        }

        async function snapshot(): Promise<Snapshot> {
            const out: Snapshot = { browse: [], search: {}, pinned: {} };
            await ob.resetPlugin({});
            await ob.openNavigator();
            out.browse = (await ob.rows()).map((r) => r.text);
            for (const q of QUERIES)
                out.search[q] = folderTexts(await ob.query(q));
            for (const mode of ["recency", "frequency"]) {
                await ob.resetPlugin({
                    folderDisplayMode: mode,
                    folderHistory: VISITED,
                });
                await ob.openNavigator();
                const rows = await ob.rows();
                const end = rows.findIndex(
                    (r, i) => i > 0 && r.kind === "separator",
                );
                assert.equal(rows[0].kind, "separator");
                out.pinned[mode] = {
                    pinned: rows.slice(1, end).map((r) => r.text),
                    rest: rows.slice(end + 1).map((r) => r.text),
                };
            }
            await ob.closeModals();
            return out;
        }

        test("browse lists and search order match the old build", async () => {
            const current = await snapshot();
            const built = readFileSync(join(ob.pluginDir, "main.js"), "utf8");
            let old: Snapshot;
            try {
                await ob.installMainJs(await buildAtRef(OLD_REF));
                old = await snapshot();
            } finally {
                await ob.installMainJs(built);
            }
            assert.deepEqual(current.browse, old.browse);
            assert.deepEqual(current.search, old.search);
            // Intended difference (SEC-3): v0.5.0 looked up history["constructor"],
            // found Object.prototype.constructor and pinned the never-visited
            // folder "constructor". Otherwise the pinned block and the list
            // below it must match.
            for (const mode of ["recency", "frequency"]) {
                const o = old.pinned[mode];
                const c = current.pinned[mode];
                assert.ok(
                    o.pinned.includes("constructor"),
                    `v0.5.0 bug reproduced (${mode})`,
                );
                assert.deepEqual(
                    c.pinned,
                    o.pinned.filter((p) => p !== "constructor"),
                    mode,
                );
                const rest = c.rest.filter((p) => p !== "constructor");
                assert.deepEqual(rest.slice(0, o.rest.length), o.rest, mode);
            }
        });
    });

    describe("mobile (§6.7)", () => {
        test("emulated mobile: navigating opens the drawer and reveals the folder", async () => {
            await ob.resetPlugin({});
            await ob.reloadWindow(({ app }) => app.emulateMobile(true));
            try {
                assert.equal(
                    await ob.evaluate(({ app }) => app.isMobile),
                    true,
                );
                await ob.evaluate(({ app }) =>
                    app.workspace.leftSplit.collapse(),
                );
                await ob.navigate("notes", "B/notes");
                await ob.waitForHighlight("B/notes");
                assert.equal(
                    await ob.evaluate(
                        ({ app }) => app.workspace.leftSplit.collapsed,
                    ),
                    false,
                );
            } finally {
                await ob.reloadWindow(({ app }) => app.emulateMobile(false));
            }
        });
    });

    test("no plugin errors were logged during the run", () => {
        const ours = ob.errors.filter((e) =>
            /folder-navigator|Folder Navigator/i.test(e),
        );
        assert.deepEqual(ours, []);
    });
});
