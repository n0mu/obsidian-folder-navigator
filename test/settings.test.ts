import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, parseSettings } from "../src/settings.ts";
import { getEntry } from "../src/history.ts";

test("missing or non-object data gives defaults", () => {
    for (const raw of [null, undefined, "x", 3, []]) {
        assert.deepEqual(
            { ...parseSettings(raw), folderHistory: {} },
            { ...defaultSettings(), folderHistory: {} },
        );
    }
});

test("each call returns a fresh history object", () => {
    const a = parseSettings(null);
    const b = parseSettings(null);
    assert.notEqual(a.folderHistory, b.folderHistory);
    a.folderHistory.x = { lastAccessed: 1, accessCount: 1 };
    assert.equal(getEntry(b.folderHistory, "x"), undefined);
});

test("valid stored values are kept", () => {
    const s = parseSettings({
        maxResults: 25,
        expandTargetFolder: false,
        debugMode: true,
        folderDisplayMode: "frequency",
        recentFoldersToShow: 3,
        frequentFoldersToShow: 12,
        folderHistory: { a: { lastAccessed: 1, accessCount: 2 } },
        newFolderLocation: "Inbox",
    });
    assert.equal(s.maxResults, 25);
    assert.equal(s.expandTargetFolder, false);
    // Removed setting (debug mode, D3): stale keys are dropped, not kept.
    assert.ok(!("debugMode" in s));
    assert.equal(s.folderDisplayMode, "frequency");
    assert.equal(s.recentFoldersToShow, 3);
    assert.equal(s.frequentFoldersToShow, 12);
    assert.deepEqual(getEntry(s.folderHistory, "a"), {
        lastAccessed: 1,
        accessCount: 2,
    });
    assert.equal(s.newFolderLocation, "Inbox");
});

test("wrong types fall back to defaults, numbers are clamped", () => {
    const d = defaultSettings();
    const s = parseSettings({
        maxResults: "abc",
        expandTargetFolder: "yes",
        folderDisplayMode: "alphabetical",
        recentFoldersToShow: 999,
        frequentFoldersToShow: -4,
        folderHistory: null,
        newFolderLocation: 7,
        unknownKey: true,
    });
    assert.equal(s.maxResults, d.maxResults);
    assert.equal(s.expandTargetFolder, d.expandTargetFolder);
    assert.equal(s.folderDisplayMode, d.folderDisplayMode);
    assert.equal(s.recentFoldersToShow, 20);
    assert.equal(s.frequentFoldersToShow, 1);
    assert.deepEqual(Object.keys(s.folderHistory), []);
    assert.equal(s.newFolderLocation, "");
    assert.equal("unknownKey" in s, false);
    assert.equal(parseSettings({ maxResults: 1000 }).maxResults, 50);
    assert.equal(parseSettings({ maxResults: Infinity }).maxResults, 10);
});
