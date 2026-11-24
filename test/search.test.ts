import { test } from "node:test";
import assert from "node:assert/strict";
import {
    searchFolders,
    shouldOfferCreate,
    type FolderLike,
} from "../src/search.ts";

function folders(...paths: string[]): FolderLike[] {
    return paths.map((path) => ({
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
    }));
}

function search(paths: string[], query: string, limit = 10): string[] {
    return searchFolders(folders(...paths), query, limit).map(
        (h) => h.folder.path,
    );
}

function scores(paths: string[], query: string): Record<string, number> {
    return Object.fromEntries(
        searchFolders(folders(...paths), query, 100).map((h) => [
            h.folder.path,
            h.score,
        ]),
    );
}

test("keywords match in any order", () => {
    assert.deepEqual(search(["foo", "foo/bar/baz", "baz"], "bar foo"), [
        "foo/bar/baz",
    ]);
    assert.deepEqual(search(["foo", "foo/bar/baz", "baz"], "foo bar"), [
        "foo/bar/baz",
    ]);
});

test("every keyword must match", () => {
    assert.deepEqual(search(["foo/bar", "foo/qux"], "foo bar"), ["foo/bar"]);
    assert.deepEqual(search(["foo/bar"], "foo zzz"), []);
});

test("exact name beats name-in-path beats name prefix", () => {
    const paths = ["projects/notes-archive", "notes", "work/notes"];
    assert.deepEqual(search(paths, "notes"), [
        "notes",
        "work/notes",
        "projects/notes-archive",
    ]);
});

test("scores are unchanged from v0.5.0", () => {
    // Pinned so a refactor can't silently reorder results.
    assert.deepEqual(
        scores(["notes", "work/notes", "projects/notes-archive"], "notes"),
        {
            notes: 440,
            "work/notes": 425,
            "projects/notes-archive": 259,
        },
    );
    assert.deepEqual(scores(["foo/bar"], "bar foo"), { "foo/bar": 489 });
    assert.deepEqual(scores(["foo/bar/baz"], "bar foo"), {
        "foo/bar/baz": 190,
    });
    assert.deepEqual(scores(["xabc"], "abc"), { xabc: 240 });
});

test("a matching parent hides children with no extra matches", () => {
    assert.deepEqual(search(["abc", "abc/x", "abc/x/y"], "abc"), ["abc"]);
    assert.deepEqual(search(["foo/bar", "foo/bar/baz"], "bar foo"), [
        "foo/bar",
    ]);
});

test("a child with more keyword occurrences than its parent is kept", () => {
    assert.deepEqual(search(["abc", "abc/x", "abc/y/abc"], "abc"), [
        "abc",
        "abc/y/abc",
    ]);
});

test("only top-level matches hide descendants", () => {
    // "abc/y/abc" is kept as a child of "abc", but it does not itself become a
    // parent: its own children are compared against "abc" (1 occurrence), so
    // "abc/y/abc/z" (2) is shown even though it adds nothing over "abc/y/abc".
    assert.deepEqual(
        search(["abc", "abc/y/abc", "abc/y/abc/z", "abc/y/abc/abc"], "abc"),
        ["abc", "abc/y/abc", "abc/y/abc/abc", "abc/y/abc/z"],
    );
});

test("matching is case-insensitive", () => {
    assert.deepEqual(search(["Projects/Alpha", "beta"], "ALPHA"), [
        "Projects/Alpha",
    ]);
    assert.deepEqual(search(["Projects/Alpha"], "  pro  ALP "), [
        "Projects/Alpha",
    ]);
});

test("equal scores keep the input order", () => {
    assert.deepEqual(search(["b/x", "a/x", "c/x"], "x"), ["b/x", "a/x", "c/x"]);
});

test("limit applies after dedupe", () => {
    const paths = ["abc", "abc/1", "abc/2", "xabc", "yabc", "zabc"];
    assert.deepEqual(search(paths, "abc", 3), ["abc", "xabc", "yabc"]);
});

test("create option is offered unless the query names a shown folder", () => {
    const hits = searchFolders(folders("Work/Notes", "Archive"), "notes", 10);
    assert.equal(shouldOfferCreate(hits, "notes"), false); // name match
    assert.equal(shouldOfferCreate(hits, "  NOTES "), false);
    assert.equal(shouldOfferCreate(hits, "work/notes"), false); // path match
    assert.equal(shouldOfferCreate(hits, "note"), true);
    assert.equal(shouldOfferCreate([], "new"), true);
    assert.equal(shouldOfferCreate(hits, "   "), false);
});

/** Character indices highlighted by a hit (ranges are inclusive in v0.5.0). */
function highlighted(path: string, query: string): number[] {
    const [hit] = searchFolders(folders(path), query, 1);
    const set = new Set<number>();
    for (const [start, end] of hit?.matches ?? []) {
        for (let i = start; i <= end; i++) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
}

test("every occurrence of every keyword is highlighted", () => {
    assert.deepEqual(highlighted("Foo/foo", "foo"), [0, 1, 2, 4, 5, 6]);
    assert.deepEqual(highlighted("ab/cd", "cd ab"), [0, 1, 3, 4]);
    // Overlapping keywords highlight the union.
    assert.deepEqual(highlighted("abcd", "abc bcd"), [0, 1, 2, 3]);
    assert.deepEqual(highlighted("zzz", "z"), [0, 1, 2]);
});
