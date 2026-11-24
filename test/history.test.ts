import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createHistory,
    deleteFromHistory,
    getEntry,
    parseHistory,
    pruneHistory,
    recordVisit,
    renameInHistory,
} from "../src/history.ts";

test("prototype member names are ordinary keys", () => {
    const h = createHistory();
    assert.equal(getEntry(h, "constructor"), undefined);
    assert.equal(getEntry(h, "toString"), undefined);
    assert.equal(getEntry(h, "__proto__"), undefined);

    recordVisit(h, "__proto__", 10);
    recordVisit(h, "constructor", 20);
    assert.deepEqual(getEntry(h, "__proto__"), {
        lastAccessed: 10,
        accessCount: 1,
    });
    assert.deepEqual(getEntry(h, "constructor"), {
        lastAccessed: 20,
        accessCount: 1,
    });
    assert.equal(Object.getPrototypeOf(h), null);
    assert.deepEqual(Object.keys(h).sort(), ["__proto__", "constructor"]);
});

test("recordVisit increments count and updates timestamp", () => {
    const h = createHistory();
    recordVisit(h, "a", 1);
    recordVisit(h, "a", 5);
    assert.deepEqual(getEntry(h, "a"), { lastAccessed: 5, accessCount: 2 });
});

test("pruneHistory keeps the most recently used entries", () => {
    const h = createHistory();
    for (let i = 0; i < 5; i++) recordVisit(h, `f${i}`, i);
    assert.equal(pruneHistory(h, 3), true);
    assert.deepEqual(Object.keys(h).sort(), ["f2", "f3", "f4"]);
    assert.equal(pruneHistory(h, 3), false);
});

test("recordVisit caps the history size", () => {
    const h = createHistory();
    for (let i = 0; i < 250; i++) recordVisit(h, `f${i}`, i);
    assert.equal(Object.keys(h).length, 200);
    assert.equal(getEntry(h, "f0"), undefined);
    assert.ok(getEntry(h, "f249"));
});

test("renameInHistory moves the folder and its descendants only", () => {
    const h = createHistory();
    recordVisit(h, "a", 1);
    recordVisit(h, "a/x", 2);
    recordVisit(h, "a/x/y", 3);
    recordVisit(h, "ab", 4); // sibling sharing a prefix: must not move
    assert.equal(renameInHistory(h, "a", "b"), true);
    assert.deepEqual(Object.keys(h).sort(), ["ab", "b", "b/x", "b/x/y"]);
    assert.equal(getEntry(h, "b/x")?.lastAccessed, 2);
});

test("renameInHistory merges into an existing entry", () => {
    const h = createHistory();
    recordVisit(h, "old", 10);
    recordVisit(h, "new", 5);
    recordVisit(h, "new", 6);
    renameInHistory(h, "old", "new");
    assert.deepEqual(getEntry(h, "new"), { lastAccessed: 10, accessCount: 3 });
});

test("renameInHistory is a no-op when nothing matches", () => {
    const h = createHistory();
    recordVisit(h, "a", 1);
    assert.equal(renameInHistory(h, "z", "y"), false);
    assert.equal(renameInHistory(h, "a", "a"), false);
});

test("deleteFromHistory removes the folder and its descendants only", () => {
    const h = createHistory();
    recordVisit(h, "a", 1);
    recordVisit(h, "a/x", 2);
    recordVisit(h, "ab", 3);
    assert.equal(deleteFromHistory(h, "a"), true);
    assert.deepEqual(Object.keys(h), ["ab"]);
    assert.equal(deleteFromHistory(h, "a"), false);
});

test("parseHistory drops invalid data", () => {
    for (const raw of [null, undefined, 42, "x", [], [1, 2]]) {
        assert.deepEqual(Object.keys(parseHistory(raw)), []);
    }
    const h = parseHistory({
        good: { lastAccessed: 5, accessCount: 2 },
        "": { lastAccessed: 5, accessCount: 2 },
        nan: { lastAccessed: NaN, accessCount: 1 },
        neg: { lastAccessed: -1, accessCount: 1 },
        zeroCount: { lastAccessed: 1, accessCount: 0 },
        fraction: { lastAccessed: 1, accessCount: 1.5 },
        str: { lastAccessed: "1", accessCount: 1 },
        nul: null,
        extra: { lastAccessed: 1, accessCount: 1, junk: true },
    });
    assert.deepEqual(Object.keys(h).sort(), ["extra", "good"]);
    assert.deepEqual(getEntry(h, "extra"), { lastAccessed: 1, accessCount: 1 });
    assert.equal(Object.getPrototypeOf(h), null);
});

test("parseHistory treats a JSON __proto__ key as data", () => {
    const raw: unknown = JSON.parse(
        '{"__proto__": {"lastAccessed": 1, "accessCount": 1}}',
    );
    const h = parseHistory(raw);
    assert.deepEqual(getEntry(h, "__proto__"), {
        lastAccessed: 1,
        accessCount: 1,
    });
    assert.equal(Object.getPrototypeOf(h), null);
});
