# Folder Navigator Hardened

An [Obsidian](https://obsidian.md) plugin to quickly navigate to folders in your vault using fuzzy search.

> **This is a fork** of [wenlzhang/obsidian-folder-navigator](https://github.com/wenlzhang/obsidian-folder-navigator) (Folder Navigator 0.5.0) by wenlzhang. It has its own plugin ID, `folder-navigator-hardened`, so it installs next to the original and keeps its own settings and history. All credit for the idea and the original plugin goes to the upstream author. See [Changes from upstream](#changes-from-upstream).

![demo](/docs/attachment/demo.gif)

## Features

- Navigate to any folder with fuzzy search, the way you open files with quick switcher.
- Keywords match in any order: `bar foo` finds `foo/bar/baz`.
- Children of a matched folder are hidden unless they match more keywords, so `abc` shows `abc`, not every folder below it.
- The chosen folder is revealed in the file explorer, optionally expanded, and briefly highlighted.
- Create a folder from the search box when nothing matches.
- Order the empty-query list alphabetically, by recently visited, or by frequently visited folders, and reset that history at any time.

Open it with the command **Folder Navigator Hardened: Navigate to folder**, or bind a hotkey to it.

## Installation

This fork is for personal use. It isn't in the Community plugins directory and has no published releases. To install it, build from source:

```sh
npm ci --ignore-scripts
npm run build
mkdir -p <vault>/.obsidian/plugins/folder-navigator-hardened
cp build/main.js build/manifest.json build/styles.css <vault>/.obsidian/plugins/folder-navigator-hardened/
```

Then reload Obsidian and enable **Folder Navigator Hardened** under Community plugins.

Requires Obsidian 1.7.2 or later, on desktop and mobile.

### Verifying a release

No releases are published at the moment. If one is cut, its files are built by GitHub Actions from the tagged commit, never on a developer machine, and carry a signed [build provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds). To check a downloaded file:

```sh
gh attestation verify main.js --repo n0mu/obsidian-folder-navigator
```

## Privacy

- **No network access.** The plugin makes no requests of any kind and has no runtime dependencies.
- **Folder history stays in your vault.** In the "recently visited" and "frequently visited" modes, the plugin stores the paths of folders you navigate to, with a visit time and count, in `.obsidian/plugins/folder-navigator-hardened/data.json`. If you sync your vault, that file syncs with it. The history follows folder renames, drops deleted folders, and keeps at most 200 entries. **Reset folder history** in the settings clears it.
- Nothing is logged to the console except real errors.

## Changes from upstream

Based on upstream 0.5.0. The full audit, with a finding ID for every change, is in [`handoff.md`](handoff.md).

**Fixes**

- `minAppVersion` is now 1.7.2. Upstream declared 1.5.3 but uses APIs from 1.6.6 and 1.7.2, so it crashed on older apps.
- Revealing a folder targets the selected folder by path. Upstream clicked the first folder with the same *name*, so with `A/notes` and `B/notes` it often revealed the wrong one.
- Folder names are validated before a folder is created: empty names, `.`/`..` and hidden segments, `\ : * ? " < > |`, control characters, trailing dots and Windows reserved names are rejected with a notice. Missing parent folders are created. If the default location no longer exists, the folder is created at the vault root.
- Folders named like built-in object properties (`constructor`, `toString`, `__proto__`) no longer corrupt or fake the visit history.
- Settings from a hand-edited or synced `data.json` are type-checked and clamped; bad values fall back to defaults.
- The visit history follows renames and deletes and is capped.
- Plugin styles are scoped to its own modal. Upstream's bold match highlight leaked into every Obsidian suggester.
- Search results no longer contain the "Recently visited" separators, and the "Create new folder" row is no longer cut off when many folders match.
- Overlapping keywords no longer render duplicated characters.

**Internals**

- No private Obsidian APIs (`app.internalPlugins`) and no probing of internal prototypes. The explorer is reached through its leaf, with feature checks and a notice when it isn't available.
- Debug mode and its logging were removed.
- Search, history, settings parsing and path validation are pure modules with unit tests (`npm test`). The whole plugin is tested end to end in a real Obsidian instance (`npm run test:e2e`).
- The settings tab uses the declarative settings API on Obsidian 1.13+ (searchable in settings) and the classic one below.
- `eslint-plugin-obsidianmd`'s recommended config passes with 0 errors, 0 warnings and no disables.
- Dependencies: 0 runtime, 8 dev (down from 1 and 18), `npm audit` clean, exact versions, install scripts disabled.
- Releases are built in CI with pinned actions and provenance attestation. Dependabot updates dependencies weekly after a 7-day cooldown.

## Development

Requires Node 24 (`mise x node@24 -- npm …` works without a global install).

```sh
npm ci --ignore-scripts
npm run dev          # unminified build with inline sourcemap into build/
npm run lint
npm test             # unit tests (node --test)
npm run build        # typecheck + production build into build/
npm run test:e2e     # build, then drive a temporary Obsidian instance
```

`test:e2e` needs Obsidian installed locally (set `OBSIDIAN_BIN` if it isn't in the default place). It uses a temporary vault and profile, so it doesn't touch your own, and it is skipped when Obsidian isn't found. CI doesn't run it; `npm version` does (through `preversion`), so run releases from a machine with Obsidian.

Releasing (not used for now, the fork is for local use): `npm version <x.y.z>` (or `x.y.z-rc.n` for a pre-release) updates `manifest.json`, `versions.json` and `CHANGELOG.md`, commits, tags and pushes. The tag triggers the release workflow, which builds, attests and creates a **draft** release to review and publish.

How search scores and dedupes folders is specified by the tests in [`test/search.test.ts`](test/search.test.ts), next to the implementation in [`src/search.ts`](src/search.ts).

## License

Apache-2.0, see [LICENSE](LICENSE). Original work © 2025 wenlzhang; modifications © 2026 n0mu.
