import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFolderName } from "../src/paths.ts";

function ok(input: string): string {
    const r = validateFolderName(input);
    assert.ok(r.ok, `expected "${input}" to be valid`);
    return r.path;
}

function rejected(input: string): void {
    const r = validateFolderName(input);
    assert.equal(r.ok, false, `expected "${input}" to be rejected`);
}

test("accepts plain and nested names", () => {
    assert.equal(ok("Projects"), "Projects");
    assert.equal(ok("  My notes  "), "My notes");
    assert.equal(ok("a/b/c"), "a/b/c");
    assert.equal(ok("Ünïcödé 日本語"), "Ünïcödé 日本語");
    assert.equal(ok("v1.2 notes"), "v1.2 notes");
    assert.equal(ok("#tag-like [x]"), "#tag-like [x]");
});

test("normalises slashes and whitespace around segments", () => {
    assert.equal(ok("/a/"), "a");
    assert.equal(ok("a//b"), "a/b");
    assert.equal(ok(" a / b "), "a/b");
});

test("rejects empty input", () => {
    rejected("");
    rejected("   ");
    rejected("/");
    rejected("//  /");
});

test("rejects relative-path and hidden segments", () => {
    rejected("..");
    rejected("../x");
    rejected("a/../../x");
    rejected("./x");
    rejected(".obsidian");
    rejected("a/.hidden");
});

test("rejects invalid characters", () => {
    for (const ch of [
        "\\",
        ":",
        "*",
        "?",
        '"',
        "<",
        ">",
        "|",
        "\u0000",
        "\n",
    ]) {
        rejected(`bad${ch}name`);
    }
    rejected("C:\\Windows");
});

test("rejects Windows-unsafe names", () => {
    rejected("trailing.");
    rejected("CON");
    rejected("nul.txt");
    rejected("a/com1");
    assert.equal(ok("console"), "console");
});
