// Changelog helper.
//
//   node version-changelog.mjs              Run by `npm version` (the "version"
//                                           script). Adds a section for the new
//                                           version to CHANGELOG.md. Pre-releases
//                                           (e.g. 0.6.0-rc.1) are skipped: their
//                                           commits go into the next stable
//                                           section. Staging is left to the
//                                           "version" script.
//   node version-changelog.mjs --notes V    Print release notes for V: its
//                                           CHANGELOG.md section, or for a
//                                           pre-release, the commits since the
//                                           last stable release.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CHANGELOG = "CHANGELOG.md";
const SECTION = /^## \[([^\]]+)\]/m;

const git = (...args) =>
    execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();

const isPrerelease = (version) => version.includes("-");

/** The commit of the last stable release, or null if none can be found. */
function lastReleaseRef(changelog) {
    try {
        return git("describe", "--tags", "--abbrev=0", "--exclude=*-*");
    } catch {
        // No stable tag (e.g. a fork that didn't fetch upstream's tags). Fall
        // back to the commit `npm version` made for the newest changelog
        // version: its subject is the bare version number.
        const previous = SECTION.exec(changelog)?.[1];
        if (!previous) return null;
        const hit = git("log", "--format=%H %s")
            .split("\n")
            .find((line) => line.endsWith(` ${previous}`));
        return hit ? hit.split(" ")[0] : null;
    }
}

/** Commit subjects since the last stable release, as a Markdown list. */
function changesSinceLastRelease(changelog) {
    const base = lastReleaseRef(changelog);
    const range = base ? [`${base}..HEAD`] : [];
    const subjects = git("log", "--no-merges", "--format=%s", ...range)
        .split("\n")
        .filter((s) => s !== "" && !/^\d+\.\d+\.\d+(-\S+)?$/.test(s));
    return subjects.map((s) => `- ${s}`).join("\n") || "- No changes listed.";
}

/** The body of the CHANGELOG.md section for `version`, or null. */
function sectionFor(changelog, version) {
    const start = changelog.indexOf(`## [${version}]`);
    if (start === -1) return null;
    const bodyStart = changelog.indexOf("\n", start) + 1;
    const next = changelog.slice(bodyStart).search(SECTION);
    const body =
        next === -1
            ? changelog.slice(bodyStart)
            : changelog.slice(bodyStart, bodyStart + next);
    return body.trim();
}

const changelog = readFileSync(CHANGELOG, "utf8");

if (process.argv[2] === "--notes") {
    const version = process.argv[3];
    if (!version)
        throw new Error("usage: version-changelog.mjs --notes <version>");
    const notes =
        sectionFor(changelog, version) ??
        (isPrerelease(version)
            ? `Pre-release. Changes since the last release:\n\n${changesSinceLastRelease(changelog)}`
            : null);
    if (notes === null)
        throw new Error(`${CHANGELOG} has no section for ${version}`);
    process.stdout.write(`${notes}\n`);
} else {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    if (isPrerelease(version)) process.exit(0);
    if (sectionFor(changelog, version) !== null) {
        throw new Error(`${CHANGELOG} already has a section for ${version}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    const section = `## [${version}] - ${date}\n\n### Changes\n\n${changesSinceLastRelease(changelog)}`;

    // Insert before the first version section, with exactly one blank line
    // around it, however the surrounding whitespace looks.
    const first = changelog.search(SECTION);
    const head = (
        first === -1 ? changelog : changelog.slice(0, first)
    ).trimEnd();
    const rest = first === -1 ? "" : changelog.slice(first).trimStart();
    writeFileSync(
        CHANGELOG,
        `${head}\n\n${section}\n${rest ? `\n${rest}` : ""}`.trimEnd() + "\n",
    );
}
