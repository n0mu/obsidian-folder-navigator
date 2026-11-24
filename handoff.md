# Folder Navigator: security audit and hardening plan

Status: **audit done, no code changed yet**. Audited at commit `4175b9d` (v0.5.0) on 2026-11-24.

## How to use this file

- Each session (S1–S6 below) is sized to fit in one context window. Do them **in order**: each assumes the previous ones are merged.
- At the start of a session, read this file, then only the files listed for that session.
- At the end of a session: tick its boxes, add an entry to the **Session log** at the bottom (what changed, anything left over, new findings), and commit. One commit per session (or a few small ones) on a branch, not `main`.
- Finding IDs (`SEC-n`, `DEP-n`, …) are used in commits and the log, so the trail stays traceable.
- Node is managed with mise and no global default is set: run commands as `mise x node@24 -- npm …`, or run `mise use node@24` in the repo first (this adds a `mise.toml`; commit it).

---

## 1. Why the Community directory says "Review: Caution"

The listing at `community.obsidian.md/plugins/folder-navigator` shows **Health: Good** and **Review: Caution**. The findings behind the rating are not public; they appear only in the owner's developer dashboard. Obsidian's automated review checks: Developer Policies, best practices (the [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin) rule set), known vulnerabilities, and malware. Plugins whose latest release fails review can be delisted.

The plugin has **no network access, no `eval`/`Function`, no `innerHTML`, no Node/Electron imports, and no runtime dependencies in the bundle**. The real runtime risk is low. The rating most likely comes from these lint and policy hits, roughly in order of weight:

1. `obsidianmd/no-unsupported-api` (**error**): `Vault.getAllFolders()` is `@since 1.6.6`, but `manifest.json` declares `minAppVersion: 1.5.3`. On 1.5.3–1.6.5 the plugin throws when the modal opens. (SEC-1)
2. `obsidianmd/no-static-styles-assignment` (**error**): `el.style.display = …` in `src/settingsTab.ts:73-88`. (QUAL-1)
3. Private API use (`app.internalPlugins`) plus code that walks internal prototypes (`Object.getOwnPropertyNames(Object.getPrototypeOf(fileExplorer))`, `src/folderSuggestModal.ts:553-567`). Scanners tend to flag this kind of probing. (SEC-4)
4. Floating promises: `saveSettings()`, `handleCreateFolder()`, and `revealLeaf()` (which returns a Promise since 1.7.2). These trip `obsidianmd/no-misused-promises` and the type-checked rules. (QUAL-2)
5. Fake `TFolder` objects (`{} as TFolder`): `obsidianmd/no-tfile-tfolder-cast`. (QUAL-3)
6. Global `document`, bare `setTimeout`, two-argument `Object.assign`, and command ID containing the plugin ID: warnings `prefer-active-doc`, `prefer-window-timers`, `object-assign`, `commands/no-plugin-id-in-command-id`. (QUAL-4)
7. Known-vulnerable dev dependencies in the lockfile (12 advisories, 6 high), an esbuild version from 2021, `obsidian: "latest"`, and GitHub Actions on floating tags. (DEP-*, CI-*)

**Definition of done for the whole effort:** `npx eslint .` with `obsidianmd.configs.recommended` reports 0 errors and 0 warnings (any deliberate disable has a comment explaining it), `npm audit` reports 0, and the release is built in CI with provenance attestation. If you have dashboard access, the scanner's preview scan of the branch passes.

---

## 2. Findings

Severity is about real-world impact on the user, not scanner weight.

### Security and robustness (src)

| ID | Sev | Where | Finding | Fix (session) |
|---|---|---|---|---|
| SEC-1 | High (crash) | `manifest.json`, `folderSuggestModal.ts:79`, `settingsTab.ts:33` | `getAllFolders()` needs 1.6.6; `revealLeaf()` returns a Promise only from 1.7.2. `minAppVersion` is 1.5.3. | Bump `minAppVersion` (see decision D2) and add the matching `versions.json` entry. (S2) |
| SEC-2 | Med | `handleCreateFolder` `folderSuggestModal.ts:579-616` | Raw query text becomes a vault path. No `normalizePath`, and nothing rejects `..`/`.` segments, a leading `/`, `\`, or characters invalid on Windows or mobile (`: * ? " < > |`). The vault API is probably confined to the vault, but this hasn't been verified. At best you get inconsistent folders across platforms; at worst, path surprises. | Add a pure `validateFolderName()` (in the testable module, S3) and apply `normalizePath`. Reject empty names, `.`/`..` segments and invalid characters with a `Notice`. Check that `newFolderLocation` still exists and fall back to the root if not. (S2) |
| SEC-3 | Med | `folderHistory` (`settings.ts:16`, `folderSuggestModal.ts:105,217-227`) | A plain object is keyed by folder path. A folder named `constructor`, `toString`, etc. reads as having history, so it shows up as "recent" or "frequent". A folder named `__proto__` makes `history[path] = …` replace the object's prototype. The local object is corrupted, not the global prototype. | Look up keys with `Object.hasOwn`, and build the record with `Object.create(null)` on load, or store it as an array of entries. (S2) |
| SEC-4 | Med | `getFileExplorer` `folderSuggestModal.ts:533-574` | Undocumented `app.internalPlugins.plugins["file-explorer"].instance.revealInFolder`. In debug mode it also enumerates internal prototypes. There is no public API for revealing a folder, so some private access must stay, but it should be minimal and guarded. | Move it to `src/explorer.ts` and use the file-explorer leaf's view (`leaf.view.revealInFolder`) with `typeof` guards. Delete the prototype enumeration. Fail with a `Notice`, not silently. (S4) |
| SEC-5 | Med (wrong target) | `expandFolderByDOMClick` / `highlightFolderInDOM` `:731-852` | Searches the whole `document` for `.nav-folder-title-content` whose **text equals the folder name**. With two folders named e.g. `notes`, it clicks or highlights the first one, which is often the wrong one. It could also match a title in another pane or popout. | Search only inside the explorer leaf's `containerEl`, by path: `.nav-folder-title[data-path="${CSS.escape(path)}"]` (check `data-path` in devtools first). `revealInFolder` already expands the ancestors, so the parent-expansion chain can go; only the target needs expanding. (S4) |
| SEC-6 | Low | `loadSettings` `main.ts:29-35` | `Object.assign({}, DEFAULT_SETTINGS, data)` is a shallow merge. `DEFAULT_SETTINGS.folderHistory` is a shared object that gets mutated when `data.json` has no history. Nothing is validated: a hand-edited or synced `data.json` with wrong types (`maxResults: "abc"`, `folderHistory: null`) breaks the modal. | Add `parseSettings(raw): PluginSettings` (pure, tested): structured clone of the defaults, type checks, numeric clamps, history sanitised. (S2) |
| SEC-7 | Low | history writes | History grows without bound and is never pruned. Renamed or deleted folders leave stale entries, and every navigation calls `saveData`. Folder paths sit in `data.json` and sync with the vault, which is a minor privacy note. | Register `vault.on("rename")` / `vault.on("delete")` to move or drop entries, cap at about 200 entries (drop the oldest), and document the behaviour in the README. (S2) |
| SEC-8 | Low | `styles.css` | `.suggestion-highlight { font-weight: bold }` is global, so it restyles **every** Obsidian suggester. `.folder-separator` and `.folder-create-*` are unprefixed and can collide with other plugins. | Add a modal class (`this.modalEl.addClass("folder-navigator-modal")`), scope the rules under it, and prefix the custom classes `fn-`. (S2) |
| SEC-9 | Low | timers `:609,650-693,723,835` | Nested `setTimeout` chains with magic delays (50/100/200 ms) are never cleared, so they can fire after the plugin unloads. | After S4 one short timer is left at most. Use `window.setTimeout`, or keep handles and clear them in `onClose`. (S4) |
| SEC-10 | Info | `log()` / `debugMode` | `console.log` of every query and folder path when debug mode is on. This is noise for scanners and adds little for users. | Remove debug mode (decision D3). Keep `console.error` only for real failures. (S4) |

### Dependencies and build (`package.json` and lockfile: 525 packages, `npm audit`: 12 vulns, 1 low / 5 moderate / 6 high, all dev)

| ID | Item | Status | Action (S1) |
|---|---|---|---|
| DEP-1 | `tslib` (runtime dep) | Unused: esbuild never emits tslib helpers. `importHelpers: true` only matters for tsc emit, and tsc doesn't emit. | **Remove**, and drop `importHelpers`. Runtime dependencies become 0. |
| DEP-2 | `jest`, `ts-jest`, `@types/jest`, `jest.config.js` | No tests exist (`--passWithNoTests`). The config is broken anyway (ESM `export default` in a `.js` file without `"type":"module"`). This tree is the source of most advisories (babel, istanbul → js-yaml, picomatch, brace-expansion, browserslist). | **Remove.** Use Node's built-in `node --test` on `.ts` files (native type stripping in Node ≥ 23.6, no deps). Needs `FolderDisplayMode` changed from `enum` to a const object or union (S3). |
| DEP-3 | `eslint@8` (EOL), `@typescript-eslint/*@5`, `@eslint/js`, `eslint-config-standard`, `eslint-plugin-import`, `eslint-plugin-node` (deprecated), `eslint-plugin-promise` | Only `@typescript-eslint` is referenced by a config. There are two conflicting configs (`.eslintrc` and `.eslintrc.json`) plus `.eslintignore`. | **Replace** with `eslint@9`, `typescript-eslint@^8.70`, and `eslint-plugin-obsidianmd@0.6.x` in one flat `eslint.config.mjs` (snippet in S1). Delete both rc files and `.eslintignore`. |
| DEP-4 | `esbuild@0.13.15` | From 2021, GHSA-67mh-4wv8-2f99 (affects serve mode only, not used here). Old versions rely on a postinstall binary download. | **Upgrade** to the current 0.2x. Then `ignore-scripts=true` works. |
| DEP-5 | `builtin-modules` | Only feeds the esbuild `external` list. | **Remove.** Use `import { builtinModules } from "node:module"`. |
| DEP-6 | `obsidian: "latest"` | Unpinned: every install can pull a different typings version, which is supply-chain drift. Lock has 1.7.2 (moment advisory); current is 1.14.4. | **Pin exact** `1.14.4` (typings only, never bundled). |
| DEP-7 | `typescript@4.9`, `@types/node@16` | Outdated. No type-check runs anywhere (esbuild strips types without checking). `@types/node` isn't needed by `src`. | Upgrade to TypeScript 5.x (not 7). Remove `@types/node` unless the S1 lint of the `.mjs` scripts needs it. Add `"typecheck": "tsc --noEmit"`. |
| DEP-8 | `prettier` | Fine (zero deps), but `npm run build` runs `prettier -w`, so **the build rewrites source**. | Keep as `npm run format` only, out of `build`. |
| DEP-9 | `.npmrc` | Only `tag-version-prefix`. | Add `ignore-scripts=true`, `save-exact=true`, `engine-strict=true`, and `"engines": {"node": ">=24"}` in `package.json`. Verify the build still works with scripts disabled. |

Target devDependencies after S1: `esbuild`, `eslint`, `eslint-plugin-obsidianmd`, `typescript-eslint`, `typescript`, `obsidian`, `prettier` (7, down from 18, plus 1 runtime dependency removed).

### CI and release

| ID | Finding | Action (S6) |
|---|---|---|
| CI-1 | `actions/checkout@v3`, `setup-node@v3`, and `softprops/action-gh-release@v1` use floating tags; the v1/v3 majors are deprecated (Node 16/20 runtimes). | Pin each action to a full commit SHA with a `# vX.Y.Z` comment. |
| CI-2 | CI uses Node 18 (EOL). Plain `npm ci` runs install scripts. | Node 24, `npm ci --ignore-scripts`. |
| CI-3 | No build provenance. Obsidian has announced artifact attestation as a coming scorecard item. | Add `actions/attest-build-provenance` for `main.js`, `manifest.json`, `styles.css` (`permissions: id-token: write, attestations: write, contents: write`). |
| CI-4 | Two release paths: `postversion` runs `gh release create … build/main.js` from the **local machine** (unreproducible, unattested), **and** the tag workflow creates a draft too. | Remove `gh release create` from `postversion`, so only CI builds release assets. |
| CI-5 | No PR or push checks. | Add `ci.yml`: install with ignore-scripts, `lint`, `typecheck`, `test`, `build`, `npm audit --audit-level=moderate`. |
| CI-6 | No automated update policy. | Add `.github/dependabot.yml` for `npm` + `github-actions`, weekly, with a `cooldown` of ≥ 7 days. |
| CI-7 | `version-changelog.mjs` inserts blank-line runs (see the top of `CHANGELOG.md`) and runs `git add`, which duplicates the `version` script's own `git add`. | Fix the insertion, drop its `git add`, and clean up `CHANGELOG.md`. |

### Code-quality and lint items (not security, but they count toward the review)

- QUAL-1: `style.display` toggles in the settings tab. Render conditionally inside `display()` and re-render on dropdown change. (S5)
- QUAL-2: floating promises: `folderSuggestModal.ts:230,710`, `revealLeaf` at `:635`, and the `async` listeners in `settingsTab.ts:225`. (S2/S4)
- QUAL-3: `{} as TFolder` separators and `CreateFolderOption extends TFolder`. Replace with a discriminated union (S3).
- QUAL-4: `document` → the explorer's `containerEl` or `activeDocument`; `setTimeout` → `window.setTimeout`; two-argument `Object.assign`. (S2/S4)
- QUAL-5: command ID `open-folder-navigator` contains the plugin ID. **Do not rename it**: that would wipe users' hotkey bindings. Add `// eslint-disable-next-line obsidianmd/commands/no-plugin-id-in-command-id -- kept for hotkey back-compat`. (S2)
- QUAL-6: unused code: `folders` field and double `getAllFolders()` call (`:63,71-72`), unused `App` import (`settings.ts:1`), unused `plugin` param in `FolderSelectionModal`, empty `onunload`, unused imports `WorkspaceLeaf` and `View`.
- QUAL-7 (bug): the search sort comparator returns `0` whenever a separator is involved (`:359-368`). That is not a consistent comparator, so in recency/frequency mode the "— Recently visited —" separators land in arbitrary spots among search results. Separators should simply not appear in search results. (S3)

---

## 3. Simplification targets (preserve behaviour)

`src/folderSuggestModal.ts` is 926 lines; it should come out under 350 in total, split across files.

| What | Now | After |
|---|---|---|
| Recency and frequency branches (`:99-205`) | Two copy-pasted 50-line blocks | One `pinnedFolders(all, history, mode, limit)` with a comparator per mode |
| Separator and create items | Fake `TFolder`s and `any` casts in 8 places | `type Item = {kind:"folder"; folder; matches} \| {kind:"separator"; text} \| {kind:"create"; name}` on `SuggestModal<Item>`. `getSuggestions` is already custom, so `FuzzySuggestModal` buys nothing. |
| Highlight rendering (`:885-924`) | 40 lines building spans by hand, one `[i,i]` range per character | Merge adjacent ranges and call Obsidian's `renderMatches(el, path, ranges)`, which produces the same `suggestion-highlight` spans |
| Occurrence counting | Inline `indexOf` loops repeated 3× | `countOccurrences(haystack, needle)` |
| Scoring and dedupe | Mixed into the modal, untestable | `src/search.ts`: pure, imports **types only** from obsidian (or nothing), unit-tested |
| Navigation (`:618-852`) | Reveal → 100 ms → per-ancestor clicks at 50 ms steps → 100 ms → target click → 200 ms → highlight; ~230 lines | `explorer.ts`: `reveal(folder)` → expand the target if the setting is on → highlight. About 50 lines, one timer for removing the highlight |
| Debug logging | `log()` helper plus ~30 call sites, setting, UI toggle | Removed (D3) |
| Settings visibility | 3 element refs + `updateSettingsVisibility` | Conditional render in `display()` |
| `main.ts` | Empty `onunload`, shallow merge | `parseSettings()` + vault event listeners for history |

---

## 4. Decisions needed (recommendation first)

- **D1. Plugin identity.** This is a fork of `wenlzhang/obsidian-folder-navigator`: `manifest.json` author, `authorUrl`, `fundingUrl`, `.github/FUNDING.yml`, the README badges and links, and the LICENSE copyright line all point upstream.
  - (a) *Recommended if you'll install it yourself or publish separately:* new `id` (e.g. `folder-navigator-hardened`), new name, your author fields. Remove upstream funding. Keep upstream attribution in README and LICENSE, and add your own copyright line, since Apache-2.0 §4 requires stating changes.
  - (b) Keep the ID and upstream the fixes as PRs. Then leave the manifest identity alone and split S1–S6 into upstreamable PRs.
  - Settle this before S6. S1–S5 don't depend on it.
- **D2. `minAppVersion`.** (a) *Recommended:* **1.7.2**. It covers `getAllFolders` and Promise-returning `revealLeaf`, and loses nobody realistic. (b) **1.13.0** also unlocks `getSettingDefinitions()` and the built-in `SettingFolderControl` (folder picker with `includeRoot`), which deletes `FolderSelectionModal` and most of `settingsTab.ts`. Lint then warns `settings-tab/prefer-setting-definitions` unless you migrate. Choose (b) only if you're fine requiring 1.13+.
  - *S5 update:* the commented-disable plan below doesn't work: `obsidianmd.configs.recommended` forbids disabling `no-deprecated` and `prefer-setting-definitions` (`eslint-comments/no-restricted-disable`). S5 stays on 1.7.2 by implementing both paths, guarded with `requireApiVersion("1.13.0")`; see the S5 log.
  - *S1 update:* the baseline also flags `setDynamicTooltip` (×3) and `setWarning` as deprecated (`@typescript-eslint/no-deprecated`). The replacement, `setDestructive()`, is `@since 1.13.0`. With (a), S5 keeps both calls and adds an `eslint-disable-next-line` comment explaining the minAppVersion. With (b), they're replaced cleanly.
- **D3. Debug mode.** *Recommended:* remove the setting and its logs (stale `debugMode` keys in `data.json` are ignored by `parseSettings`). The alternative is to keep it with `console.debug` only.
- **D4. Expand-target behaviour.** `revealInFolder` already expands ancestors. `expandTargetFolder` additionally opens the target so its children show. Keep it as is (recommended).

---

## 5. Sessions

### S1: Tooling and dependency reset (no behaviour change)

Files: `package.json`, `package-lock.json`, `.npmrc`, `esbuild.config.mjs`, `tsconfig.json`, `.eslintrc*`, `.eslintignore`, `jest.config.js`, new `eslint.config.mjs`.

- [x] Remove `tslib`, jest trio + `jest.config.js`, `@eslint/js`, `eslint-config-standard`, `eslint-plugin-import|node|promise`, `builtin-modules`, `@types/node` (DEP-1,2,3,5,7).
- [x] Add/upgrade: `esbuild` (latest 0.2x), `typescript@5`, `eslint@9`, `typescript-eslint@^8.70`, `eslint-plugin-obsidianmd@0.6.x`, `obsidian@1.14.4` exact (DEP-3,4,6,7).
- [x] `.npmrc` hardening + `engines` (DEP-9). Delete `node_modules`, `npm install`, confirm `npm audit` = 0.
- [x] `esbuild.config.mjs`: `builtinModules` from `node:module`; drop `platform: 'node'`/`mainFields` (template default is browser platform + cjs); keep `minify: prod`, inline sourcemap in dev only.
- [x] `tsconfig.json`: drop `importHelpers`, `allowJs`, `inlineSources`; add `"noEmit": true`, `"strict": true` (fix only what blocks compile; real fixes come later), `"lib": ["DOM","ES2022"]`, `"module": "ESNext"`, `"moduleResolution": "bundler"`.
- [x] Scripts: `build` = `tsc --noEmit && node esbuild.config.mjs production` (still copies manifest/styles into `build/`), `lint` = `eslint .`, `typecheck`, `format` = prettier, `test` = `node --test "src/**/*.test.ts"` (no tests yet is OK). Remove `pretest` lint coupling and `gh release create` from `postversion` (CI-4).
- [x] `eslint.config.mjs` from the plugin README:
  ```js
  import { defineConfig, globalIgnores } from "eslint/config";
  import obsidianmd from "eslint-plugin-obsidianmd";
  export default defineConfig([
    globalIgnores(["node_modules", "build", "main.js", "esbuild.config.mjs", "version-bump.mjs", "version-changelog.mjs"]),
    ...obsidianmd.configs.recommended,
    { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } } } },
  ]);
  ```
  Run eslint from the repo root (the config also lints `manifest.json`, `package.json`, `LICENSE`).
- [x] **Paste the `npx eslint .` baseline into the Session log** for S2–S5. Don't fix src yet.
- [x] Accept: `npm run build` produces `build/main.js` that **loads in Obsidian and behaves identically** (verified by `npm run test:e2e`, including an old-vs-new comparison; see the E2E log); `npm audit` 0 ✅; 310 packages (the original ~200 target wasn't realistic, because `eslint-plugin-obsidianmd` alone pulls in ~250).

### S2: Correctness and safety fixes in place

Files: `manifest.json`, `versions.json`, `src/main.ts`, `src/settings.ts`, `src/folderSuggestModal.ts` (targeted edits only), `styles.css`.

- [x] SEC-1: `minAppVersion` → **1.7.2** (D2 = a). `versions.json` is left as is: `version-bump.mjs` writes the 1.7.2 entry on the next `npm version`. Every past release already called `getAllFolders` (it's in the initial commit), so the old entries understate the real requirement; they weren't rewritten.
- [x] SEC-6: `parseSettings()` in `settings.ts` (pure); fresh defaults per call via `defaultSettings()` (`DEFAULT_SETTINGS` constant removed); clamps; validates mode; sanitises history.
- [x] SEC-3: `src/history.ts` holds null-prototype history and `getEntry()` uses `hasOwnProperty.call`. `Object.hasOwn` is avoided for older mobile WebViews.
- [x] SEC-7: `vault.on("rename"|"delete")` in `main.ts` → `renameInHistory` / `deleteFromHistory` (descendants included; a rename onto an existing entry merges counts). Capped at `MAX_HISTORY_ENTRIES = 200` (least recently used dropped). Saves only when something changed.
- [x] SEC-2: `src/paths.ts` `validateFolderName()` rejects empty names, segments starting with `.` (covers `.`/`..` and hidden folders), `\ : * ? " < > |` plus control characters, a trailing `.`, and Windows reserved names. `resolveCreateLocation()` falls back to the root with a Notice. `createFolderRecursive()` creates missing parents explicitly, so the `createFolder` nested-path question no longer matters.
- [x] QUAL-2: modal promises (`saveSettings` via `plugin.persistSettings()`, `handleCreateFolder`, `revealLeaf` now awaited). The settings-tab ones (ST:226, 252) remain for S5.
- [x] QUAL-5: no change needed. `commands/no-plugin-id-in-command-id` doesn't fire on `open-folder-navigator` (S1 baseline).
- [x] SEC-8: the modal gets the `folder-navigator-modal` class; all rules are scoped under it; classes are renamed `fn-separator`, `fn-create-*`, and `fn-highlighted` (the explorer highlight).
- [x] Accept: S2 lint errors are gone ✅ (97 → 80, see log). §6 checks 1–6 pass in `npm run test:e2e`.

### S3: Extract and test search; typed suggestion items

Files: new `src/search.ts`, `test/search.test.ts`, `src/folderSuggestModal.ts`.

- [x] **First** write characterization tests against the current scoring/dedupe behaviour (copy the logic into `search.ts` verbatim, test it, *then* refactor). Cover: out-of-order keywords (`"bar foo"` matches `foo/bar/baz`), exact-name ranking, parent-over-child dedupe, child kept when it has more occurrences, create-option suppressed on exact path/name match, case-insensitivity. (`validateFolderName`, `parseSettings` and history already have tests, written in S2.)
- [x] `enum FolderDisplayMode` → `as const` object + union type. Done early in S2 so `settings.ts` could be tested.
- [x] Move to `SuggestModal<Item>` with the discriminated union (QUAL-3); separators only in the empty-query list (QUAL-7); unify recency/frequency; `renderMatches` with merged ranges.
- [x] Accept: `npm test` green ✅ (39 tests); `no-tfile-tfolder-cast` gone ✅; identical ordering for the same queries ✅ (the e2e suite builds v0.5.0 from git and compares lists in Obsidian; the only difference is the SEC-3 fix).

### S4: Navigation and file explorer rewrite

Files: new `src/explorer.ts`, `src/folderSuggestModal.ts`.

- [x] SEC-4: one guarded accessor for the explorer leaf + `revealInFolder`; no prototype enumeration; Notice when the explorer is unavailable (e.g. core plugin disabled).
- [x] SEC-5: path-based selector scoped to the explorer leaf `containerEl`; drop ancestor click chain; expand target only (`is-collapsed` check) per `expandTargetFolder`.
- [x] SEC-9/10: remove debug mode + `log()`; window timers; clear the highlight timer handle.
- [x] Test duplicate folder names (`A/notes`, `B/notes`), deep nesting, explorer closed/collapsed sidebar, mobile (drawer), and a popout window. All automated in `e2e/`.
- [x] Accept: `prefer-active-doc`, `prefer-window-timers` warnings gone ✅; §6 checks 1–4, 7 pass ✅.

### S5: Settings tab and main cleanup

Files: `src/settingsTab.ts`, `src/main.ts`.

- [x] QUAL-1: conditional rendering instead of `style.display`; re-render on mode change (`update()` on 1.13+, `display()` below).
- [x] If D2 = 1.13: migrate to `getSettingDefinitions()` + `SettingFolderControl`, delete `FolderSelectionModal`. Otherwise keep the modal but drop its unused `plugin` param and use `getAllFolders(true)` so root is selectable.
- [x] Remove debug toggle (D3), done in S4. Headings via `setHeading()` (already), sentence case text.
- [x] Accept: `npx eslint .` → **0 errors, 0 warnings**, with **no** disables (the recommended config forbids disabling these rules; see the S5 log). `npm run typecheck` clean.

### S6: Release pipeline, metadata, docs

Files: `.github/workflows/*`, `.github/dependabot.yml`, `.github/FUNDING.yml`, `manifest.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `version-changelog.mjs`, `package.json`.

- [ ] CI-1…7 as listed. Release workflow: `npm ci --ignore-scripts` → `npm run lint && npm run typecheck && npm test && npm run build` → attest → draft release with `build/main.js`, `build/manifest.json`, `build/styles.css`.
- [ ] D1 identity changes; README: fork notice, what changed vs upstream, privacy note (history stored in `data.json`, no network access), remove stale `docs/implementation/SEARCH_IMPROVEMENTS.md` or update it to point at `search.ts` tests.
- [ ] `validate-manifest` / `validate-license` lint clean.
- [ ] Accept: tag a pre-release in the fork; workflow green; `gh attestation verify build/main.js --repo n0mu/obsidian-folder-navigator` succeeds; (if you have dashboard access) preview scan passes.

---

## 6. Test checklist (automated: `npm run test:e2e`)

Every item below is covered by `e2e/plugin.e2e.ts`. The suite runs in a separate Obsidian instance with a temporary vault and profile, takes about 12 s, and needs Obsidian installed (`OBSIDIAN_BIN` overrides the path). Only Obsidian 1.15.1 (the installed version) has been tested; `minAppVersion` 1.7.2 itself has not.

1. Empty query lists folders; in recency/frequency mode the pinned block + separators show and are not selectable.
2. `bar foo` finds `foo/bar/baz`; parent `abc` hides `abc/x` children without extra matches.
3. Selecting a folder reveals it in the explorer, expands it (if enabled), highlights ~2 s.
4. Two folders with the same name: the **selected** one is revealed/highlighted.
5. Create folder: plain name; nested `a/b`; rejected `../x`, `x:y`, empty; custom default location; default location deleted afterwards → falls back to root.
6. Rename/delete a visited folder → history follows/prunes; folder named `constructor` / `__proto__` behaves normally.
7. Explorer core plugin disabled → Notice, no exception. Mobile: works from the drawer.
8. Settings: mode switch shows the right sliders; reset history confirm works; values survive reload; corrupted `data.json` values fall back to defaults.

---

## 7. Session log

<!-- Newest last. Template:
### S<n> - YYYY-MM-DD - <branch/commit>
- Done: …
- Deviations from plan: …
- New findings: …
- Lint/audit state: …
-->

### S0 - 2026-11-24 - audit (this file)
- Read all of `src/`, configs, CI, and scripts. `npm audit --package-lock-only`: 12 vulns (1 low, 5 mod, 6 high), all in devDependencies.
- Confirmed from `obsidian@1.14.4` typings: `getAllFolders` @since 1.6.6, `revealLeaf(): Promise<void>` @since 1.7.2, `createFolder` throws if the folder exists, `renderMatches`/`normalizePath` exported, `getSettingDefinitions` + `SettingFolderControl` @since 1.13.0.
- Community directory: "Health: Good / Review: Caution". The specific findings are only visible in the developer dashboard; §1 is inferred from the `eslint-plugin-obsidianmd` rules and the code.
- Not yet verified (do it in the named session): that the explorer uses the `data-path` attribute (S4), and how `vault.createFolder` handles `..` and nested paths (S2).

### S1 - 2026-11-24 - branch `hardening`
- Done: all S1 tooling items. devDependencies went from 18 to 7 and runtime dependencies from 1 to 0. The lockfile went from 525 packages to 310, and `npm audit` from 12 vulns to **0**.
  - Pinned exact versions, each published ≥ 7 days before install: esbuild 0.28.2, typescript 6.0.3 (TS 7 is unsupported by typescript-eslint), eslint 9.39.5, typescript-eslint 8.73.0, eslint-plugin-obsidianmd 0.6.0, obsidian 1.14.4, prettier 3.10.1.
  - ESLint 9 now prints "no longer supported" on install. ESLint 10 is blocked until `eslint-plugin-obsidianmd`'s bundled plugins declare support (per its README). Revisit when the plugin updates.
  - `overrides` in package.json: `@microsoft/eslint-plugin-sdl` pins `eslint-plugin-n@17.10.3`, which pulls vulnerable `minimatch@9` (GHSA-g3hv-75wg-m249). It's overridden to `17.24.0` (same major, no minimatch dependency). `@typescript-eslint/utils` is overridden to 8.73.0 to dedupe with typescript-eslint. **Remove both overrides when the plugin or sdl update.**
  - `package.json` now has `"type": "module"`, `"private": true`, `"license"`, and `engines.node >=24`. `.npmrc` has `ignore-scripts`, `save-exact` and `engine-strict`. The build works with install scripts disabled, using esbuild's platform package.
  - `tsconfig.json`: `strict`, `noEmit`, `moduleResolution: bundler`. There were 5 strict-mode compile errors; I fixed them minimally without changing behaviour (`settings!`, optional settings-tab element refs, `unknown` error narrowing in `handleCreateFolder`).
  - `build`: `tsc --noEmit` then esbuild. Prettier no longer runs in the build. `postversion` no longer creates a GitHub release locally (CI-4 done early).
- **Not verified:** loading `build/main.js` (14.9 kB, only `require("obsidian")`) in a real vault. Run §6 checks 1–3 before or at the start of S2.
- Lint baseline: `npx eslint .` reports **97 problems (48 errors, 49 warnings)**, all in `src/`. `manifest.json`, `package.json` and `LICENSE` pass. Line numbers refer to the S1 commit. FSM = `folderSuggestModal.ts`, ST = `settingsTab.ts`.

  | Count | Rule | Sev | Where | Session |
  |---|---|---|---|---|
  | 2 | obsidianmd/no-unsupported-api (`getAllFolders` needs 1.6.6) | E | FSM:79, ST:33 | S2 |
  | 8 | obsidianmd/no-static-styles-assignment | E | ST:73–88 | S5 |
  | 3 | @typescript-eslint/no-floating-promises | E | FSM:230 (saveSettings), 637 (revealLeaf), 712 (handleCreateFolder) | S2 |
  | 2 | obsidianmd/no-misused-promises (async click/onSelect callbacks) | E | ST:225, 251 | S5 |
  | 1 | obsidianmd/rule-custom-message → **no-console** (`console.log` in `log()`) | E | FSM:20 | S4 |
  | 20+1+3 | no-unsafe-member-access / no-unsafe-return / no-unsafe-argument (`any` casts for separators, `log(...args: any[])`) | E | FSM, many | S3 / S4 |
  | 2 | no-unnecessary-type-assertion | E | FSM:480, 488 | S3 |
  | 5 | restrict-template-expressions (`${error}` with `unknown`) | E | FSM:571, 613, 697, 794, 852 | S2/S4 |
  | 1 | no-unsafe-assignment (`loadData()` result) | E | main:30 | S2 (`parseSettings`) |
  | 24 | no-explicit-any | W | FSM, many | S3 / S4 |
  | 5 | obsidianmd/no-tfile-tfolder-cast | W | FSM:129, 135, 184, 190, 469 | S3 |
  | 8 | obsidianmd/prefer-window-timers | W | FSM:609–837 | S4 |
  | 2 | obsidianmd/prefer-active-doc | W | FSM:738, 809 | S4 |
  | 3 | obsidianmd/prefer-instanceof | W | FSM:752, 762, 823 | S4 |
  | 4 | no-deprecated (`setDynamicTooltip` ×3, `setWarning`; replacements need 1.13, see D2) | W | ST:143, 161, 176, 193 | S5 |
  | 1 | settings-tab/prefer-setting-definitions | W | ST:45 | S5 (D2) |
  | 2 | no-unused-vars (`WorkspaceLeaf`, `App`) | W | FSM:5, settings:1 | S2 |

  Not fired: `commands/no-plugin-id-in-command-id`, `object-assign`, `validate-manifest`, `validate-license`.
- Next: S2. Settle D2 (`minAppVersion` 1.7.2 vs 1.13.0) first, because it decides how S5 handles the deprecations.

### S2 - 2026-11-24 - branch `hardening`
- Done: SEC-1, 2, 3, 6, 7, 8 and QUAL-2 (modal side), as ticked above. D2 decided: **1.7.2**.
- New pure modules, each with no Obsidian runtime import:
  - `src/history.ts`: create / get / record / rename / delete / prune / parse.
  - `src/paths.ts`: `validateFolderName`.
  - `src/settings.ts`: `defaultSettings` / `parseSettings`; `FolderDisplayMode` is now a const object plus a union type.
  - Between pure modules, relative imports use the `.ts` extension (`allowImportingTsExtensions`), so Node can run them directly. Obsidian-facing files import without an extension; esbuild handles both.
- Deviation, tests: they live in **`test/`**, not `src/`, with their own `test/tsconfig.json` (`types: ["node"]`). The root tsconfig has `types: []`, so plugin code can't silently use Node globals. Added `@types/node@24.19.2` (dev only).
  - `npm test` = `node --test "test/**/*.test.ts"`: **20 tests pass**.
  - `npm run typecheck` checks both projects.
  - ESLint turns off `no-floating-promises` and `no-nodejs-modules` for `test/**` only.
- tsconfig: `verbatimModuleSyntax` is on, so type-only imports must say `import type`. This also stops esbuild from keeping a runtime `main` ↔ `settingsTab` circular import.
- `npm run format` now also formats `test/`. Prettier 3.10 re-wrapped some untouched lines in `folderSuggestModal.ts` and `settingsTab.ts` (formatting only).
- Behaviour changes (intentional):
  - Creating a folder now rejects bad names with a Notice instead of passing them to the vault.
  - Nested names create missing parents.
  - A missing default location falls back to the root.
  - History follows renames and deletes and is capped at 200 entries.
  - The `.suggestion-highlight` bold no longer leaks into other suggesters.
- Lint: 97 → **80 problems (35 errors, 45 warnings)**. All remaining items are assigned to S3 (any-casts and separators, TFolder casts, unnecessary assertions), S4 (console.log, timers, `document`, `instanceof`) or S5 (style.display, settings-tab promises, deprecations, setting definitions).
- Build: `build/main.js` 18.5 kB, still only `require("obsidian")`. `npm audit`: 0.
- **Still not verified in a real vault**: §6 checks 1–6. Do this at the start of S3. In particular, confirm that renaming a visited folder keeps its "recent" position, and that the explorer highlight still shows (the class is now `fn-highlighted`).
- Next: S3.

### S3 - 2026-11-24 - branch `hardening`
- Done: all S3 items. Two commits: first the characterization (logic copied verbatim into `src/search.ts`, 12 tests pinning order, exact scores, dedupe, the create-option rule and highlighted characters), then the refactor with those tests unchanged apart from the range format.
- `src/search.ts` (pure, imports only `history.ts` and `settings.ts`): `searchFolders`, `shouldOfferCreate`, `pinnedFolders` (one function for recency and frequency), `parseKeywords`, `countOccurrences`, `mergeRanges`. Highlight ranges are now merged, sorted, half-open `[start, end)`, which is what `renderMatches` takes.
- `FolderSuggestModal` now extends `SuggestModal<Item>`, where `Item` is `folder | separator | create`. No fake `TFolder`s or `any` casts remain for list rows. The unused `folders` field, the double `getAllFolders()` call, `getItems` and `getItemText` are gone. 938 → 521 lines; the rest is navigation code for S4.
- Confirmed in the Obsidian 1.15.1 bundle: `SuggestModal.updateSuggestions` slices the list to `limit` **after** `getSuggestions`, and `selectSuggestion` closes the modal before calling `onChooseSuggestion`.
- Behaviour changes (intentional):
  - QUAL-7: search results no longer contain the "Recently/Frequently visited" separators. Before, they took 2 of the `maxResults` slots and landed in arbitrary places. Ties still favour pinned folders, because search runs over pinned-first order.
  - **New bug fixed:** the "Create new folder" row was cut off whenever a query matched `maxResults` or more folders, because of the `limit` slicing above. The modal now sets `limit = 0` and limits rows itself: maxResults hits plus the create row. The empty-query list is still cut to `maxResults` rows with separators counted, as before.
  - Separators can't be chosen any more: `selectSuggestion` is overridden, so clicking a separator or pressing Enter on one does nothing. Before, it closed the modal. They also get `cursor: default` via the new `fn-separator-item` class.
  - **New bug fixed:** overlapping keywords (e.g. `abc bcd` on `abcd`) used to render duplicated characters, because the per-character ranges overlapped. Merged ranges fix this.
- New finding, not fixed (preserved and pinned by a test): dedupe compares only against **top-level** matched ancestors. A kept child does not hide its own children, so `abc/y/abc/z` is shown under `abc/y/abc` for the query `abc`. Change it only if you want different results.
- Lint: 80 → **31 problems (11 errors, 20 warnings)**. Left for S4 (folderSuggestModal: console ×1, `any` ×2 in the explorer interfaces, window timers ×8, active doc ×2, instanceof ×3) and S5 (settingsTab: style.display ×8, misused promises ×2, deprecated ×4, setting definitions ×1). `npm run typecheck` is clean; `npm audit` is 0.
- Build: `build/main.js` 17.2 kB, still only `require("obsidian")`.
- **Still not verified in a real vault:** §6 checks 1–6 (carried over from S1 and S2), plus for S3: highlighting looks the same, separators are inert, the create row appears with many matches, and the empty-query list matches the old build in recency and frequency mode.
- Next: S4.

### S4 - 2026-11-24 - branch `hardening`
- Done: SEC-4, 5, 9, 10, and D3 (debug mode removed). The S5 item "remove debug toggle" was done here too: removing the setting meant removing the toggle.
- Checked in the Obsidian 1.15.1 bundle (`~/Library/Application Support/obsidian/obsidian-1.15.1.asar`) before writing the code:
  - The file-explorer **view** has `revealInFolder(file)`. It expands collapsed ancestors, focuses the item, and scrolls it into view on the next frame. The **plugin instance**'s async `revealInFolder` only adds "find or create the leaf, `revealLeaf`, `setActiveLeaf`" on top.
  - Explorer title rows (`.nav-folder-title`) carry `data-path` = the file's path, which answers the S0 open question.
  - Clicking a folder title toggles it.
  - `Modal.close()` restores the previous selection synchronously, and `selectSuggestion` closes the modal before calling `onChooseSuggestion`. So the 100 ms "wait for the modal to close" delays are gone.
- New `src/explorer.ts` (`FolderRevealer`, owned by the plugin; `cancel()` runs on unload via `this.register`):
  1. Take the existing `file-explorer` leaf (`getLeavesOfType`).
  2. `await revealLeaf`, which also loads a deferred view and opens the drawer on mobile.
  3. Feature-check `view.revealInFolder` and call it.
  4. Wait up to 30 animation frames for `.nav-folder-title[data-path="…"]` inside **that leaf's** `containerEl`.
  5. If expanding is on and `.nav-folder` is `is-collapsed`, click the title once.
  6. Highlight for 2 s with one `el.win.setTimeout`, cleared on the next reveal or on unload.
  - A "generation" counter stops stale work when a new reveal starts or the plugin unloads.
  - Failures show a Notice and log with `console.error`. Nothing fails silently.
- Deviation from plan: when no explorer leaf exists, the plugin shows a Notice instead of creating one. `ensureSideLeaf` would create a broken "plugin not active" leaf when the Files core plugin is disabled, and checking whether it's enabled needs `app.internalPlugins`. As a result, `internalPlugins` is no longer used anywhere. Trade-off: if the user closed the explorer tab while the core plugin is still enabled, they now get a Notice where the core plugin would have reopened the tab.
- Removed: the ancestor click chain (it clicked by **name**, so with duplicate names it hit the first match), whole-`document` queries, prototype enumeration, `log()` with its ~30 call sites, the private-API interfaces, `getParentFolderChain`, and every bare `setTimeout`.
- The modal goes from 521 to 216 lines; with `explorer.ts` (123) that's 339 in total.
- `debugMode` was removed from `PluginSettings`. `parseSettings` drops the stale key; the test now asserts this.
- Lint: 31 → **15 problems (10 errors, 5 warnings)**, all in `settingsTab.ts` and all S5: style.display ×8, misused promises ×2, deprecated ×4, setting definitions ×1. Typecheck clean, 39 tests pass, `npm audit` 0. Build: `build/main.js` 15.2 kB, only `require("obsidian")`, and it contains no `internalPlugins`, `getPrototypeOf` or `console.log`.
- **Not verified in a real vault** (S4 is the riskiest session for this):
  - §6 checks 1–4 and 7.
  - Duplicate names (`A/notes`, `B/notes`).
  - Deep nesting with collapsed ancestors.
  - A collapsed sidebar.
  - Mobile drawer.
  - Popout window.
  - Creating a folder and then revealing it.
  - Rapid repeated navigation: the highlight should move, not stack.
- Left for S6: `docs/implementation/SEARCH_IMPROVEMENTS.md` still describes debug logging.
- Next: S5.

### E2E - 2026-11-24 - branch `hardening`, commit `0862803`
- Automated every pending manual check (§6 1–8 and the S1–S4 leftovers) as `npm run test:e2e`. **32 tests, all passing**; three consecutive runs were stable, each about 12 s.
- How it works (`e2e/`, no new dependencies):
  - It launches the installed Obsidian with a temporary `--user-data-dir` and a temporary vault, so it's a separate instance. The user's own Obsidian and vaults are untouched, and it can run while Obsidian is open.
  - It drives the app over the Chrome DevTools Protocol, using Node's built-in WebSocket and `fetch`.
  - Input in the main window uses real CDP input events. Popout and settings windows use DOM events, because CDP input only reaches the main window.
  - The vault's "Trust author and enable plugins" dialog is answered the way a user would answer it.
  - `FN_E2E_KEEP=1` keeps the temporary vault for inspection.
- The old-vs-new check builds v0.5.0 (`4175b9d`) from git with esbuild and runs it in the same vault. Searches and the default browse list are identical. The recency and frequency lists differ only by the SEC-3 fix: v0.5.0 pins a never-visited folder named `constructor`, because `history["constructor"]` returns `Object.prototype.constructor`.
- Found and fixed:
  - With the Files core plugin disabled, the explorer leaf stays open with a placeholder view. The plugin showed "this version of the file explorer can't reveal folders". It now uses the first leaf that can reveal, and otherwise shows "the file explorer isn't available. Enable the Files core plugin…".
- Found, not ours:
  - **A folder named `__proto__` breaks Obsidian itself** (checked with no plugins installed). The vault's file map is a plain object, so the folder replaces its prototype and the folder never appears. So `__proto__` is tested as a `data.json` history key, the way this plugin actually encounters it.
- Facts learned about Obsidian 1.15.1 (they shaped the tests):
  - Settings open in their **own window** (`app.setting.shouldUsePopout()`).
  - Notices raised from settings appear in that window.
  - Enabling a plugin while a dialog-triggered load is still in `onload` loads a **second** instance and leaks the first. This was a harness bug, now fixed. A test now checks that a reload leaves exactly one settings tab.
- Not covered: Obsidian versions other than 1.15.1 (`minAppVersion` is 1.7.2), real mobile devices (only `app.emulateMobile`), and CI (runners don't have Obsidian; see S6).

### S5 - 2026-11-24 - branch `hardening`
- Done: QUAL-1, the misused promises, the deprecations and prefer-setting-definitions. **`npx eslint .` reports 0 problems, with no `eslint-disable` anywhere.** Typecheck is clean, 39 unit and 32 e2e tests pass, `npm audit` reports 0, and `build/main.js` is 15.0 kB (only `require("obsidian")`).
- **Deviation from plan:** the plan said to keep `setDynamicTooltip` and `setWarning` behind commented `eslint-disable`s (D2 = 1.7.2). The recommended config **forbids** disabling `@typescript-eslint/no-deprecated` and `settings-tab/prefer-setting-definitions` (`eslint-comments/no-restricted-disable`), so the review would still flag them. Instead, the tab now supports both API generations without raising `minAppVersion`. I confirmed in the 1.15.1 bundle that `renderTab()` uses the declarative path whenever `getSettingDefinitions()` returns items and calls `display()` otherwise.
  - Every setting is defined once, as a row `{ name, desc, visible?, render(setting) }` in a group.
  - On 1.13+, `getSettingDefinitions()` maps the rows to groups of `SettingDefinitionRender` items. Obsidian renders them, re-evaluates `visible` on `update()`, and indexes them for settings search, which is what `prefer-setting-definitions` asks for.
  - Below 1.13, `display()` renders the same rows. An e2e test checks that both paths list the same rows in each mode.
  - Mode changes call `refresh()`, which is `update()` on 1.13+ and `display()` below, gated by `requireApiVersion("1.13.0")`. The `no-unsupported-api` rule accepts that guard.
  - Sliders: `setDynamicTooltip()` is a no-op on 1.15, where the value shows inline. Below 1.13, a small `fn-slider-value` label shows the value instead.
  - Reset button: 1.13+ uses `setDestructive().setCta()`, which is what `setWarning()` does there now. Below 1.13 it adds the `mod-warning` class, which is what `setWarning()` did there.
- The folder picker no longer takes the unused `plugin` parameter, and it lists the vault root (`getAllFolders(true)`, shown as "/ (Root)", stored as `""`).
- The confirm dialog is now a small `ConfirmResetModal` class.
- All saves go through `plugin.persistSettings()`, which is fire-and-forget with error logging, so no async callbacks remain.
- `main.ts` needed no changes.
- Not verified: rendering on Obsidian below 1.13. The e2e test calls `display()` on 1.15, which proves the rows and visibility logic but uses 1.15's components.
- Next: S6. Settle D1 (plugin identity) first. Running `test:e2e` in CI would need Obsidian downloaded on the runner plus xvfb on Linux; decide whether that's worth it, or keep e2e local and run it before each release.
