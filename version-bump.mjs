import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) throw new Error("run through `npm version`");

// Bump manifest.json to the target version, keeping minAppVersion.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// Record stable versions only in versions.json: Obsidian uses it to find an
// older release for apps below minAppVersion, and that must not be a
// pre-release.
if (!targetVersion.includes("-")) {
    const versions = JSON.parse(readFileSync("versions.json", "utf8"));
    versions[targetVersion] = minAppVersion;
    writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}
