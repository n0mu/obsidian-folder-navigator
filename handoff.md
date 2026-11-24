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
- **D3. Debug mode.** *Recommended:* remove the setting and its logs (stale `debugMode` keys in `data.json` are ignored by `parseSettings`). The alternative is to keep it with `console.debug` only.
- **D4. Expand-target behaviour.** `revealInFolder` already expands ancestors. `expandTargetFolder` additionally opens the target so its children show. Keep it as is (recommended).

---

## 5. Sessions

### S1: Tooling and dependency reset (no behaviour change)

Files: `package.json`, `package-lock.json`, `.npmrc`, `esbuild.config.mjs`, `tsconfig.json`, `.eslintrc*`, `.eslintignore`, `jest.config.js`, new `eslint.config.mjs`.

- [ ] Remove `tslib`, jest trio + `jest.config.js`, `@eslint/js`, `eslint-config-standard`, `eslint-plugin-import|node|promise`, `builtin-modules`, `@types/node` (DEP-1,2,3,5,7).
- [ ] Add/upgrade: `esbuild` (latest 0.2x), `typescript@5`, `eslint@9`, `typescript-eslint@^8.70`, `eslint-plugin-obsidianmd@0.6.x`, `obsidian@1.14.4` exact (DEP-3,4,6,7).
- [ ] `.npmrc` hardening + `engines` (DEP-9). Delete `node_modules`, `npm install`, confirm `npm audit` = 0.
- [ ] `esbuild.config.mjs`: `builtinModules` from `node:module`; drop `platform: 'node'`/`mainFields` (template default is browser platform + cjs); keep `minify: prod`, inline sourcemap in dev only.
- [ ] `tsconfig.json`: drop `importHelpers`, `allowJs`, `inlineSources`; add `"noEmit": true`, `"strict": true` (fix only what blocks compile; real fixes come later), `"lib": ["DOM","ES2022"]`, `"module": "ESNext"`, `"moduleResolution": "bundler"`.
- [ ] Scripts: `build` = `tsc --noEmit && node esbuild.config.mjs production` (still copies manifest/styles into `build/`), `lint` = `eslint .`, `typecheck`, `format` = prettier, `test` = `node --test "src/**/*.test.ts"` (no tests yet is OK). Remove `pretest` lint coupling and `gh release create` from `postversion` (CI-4).
- [ ] `eslint.config.mjs` from the plugin README:
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
- [ ] **Paste the full `npx eslint .` output into the Session log** as the baseline for S2–S5. Don't fix src yet.
- [ ] Accept: `npm run build` produces `build/main.js` that loads in Obsidian and behaves identically; `npm audit` 0; lockfile ~< 200 packages.

### S2: Correctness and safety fixes in place

Files: `manifest.json`, `versions.json`, `src/main.ts`, `src/settings.ts`, `src/folderSuggestModal.ts` (targeted edits only), `styles.css`.

- [ ] SEC-1: `minAppVersion` per D2 + `versions.json`.
- [ ] SEC-6: `parseSettings()` in `settings.ts` (pure, no obsidian runtime import); clone defaults; clamp `maxResults` 5–50, `recent/frequentFoldersToShow` 1–20; validate `folderDisplayMode`; sanitize history.
- [ ] SEC-3: null-prototype history / `Object.hasOwn` everywhere it's read.
- [ ] SEC-7: `registerEvent(vault.on("rename"|"delete"))` in `main.ts` to migrate/prune history (folders and their descendants: rename `a` → `b` must remap `a/x` → `b/x`); cap entries.
- [ ] SEC-2: `validateFolderName()` + `normalizePath`; check `newFolderLocation` exists (`instanceof TFolder`) else root + Notice.
- [ ] QUAL-2: `void`/await every promise (`saveSettings`, `handleCreateFolder`, `revealLeaf`).
- [ ] QUAL-5: disable comment on the command ID.
- [ ] SEC-8: scope + prefix CSS; add the modal class.
- [ ] Accept: lint errors from SEC/QUAL items above are gone; manual checks 1–6 in §6 pass.

### S3: Extract and test search; typed suggestion items

Files: new `src/search.ts`, `src/search.test.ts`, `src/folderSuggestModal.ts`, `src/settings.ts`.

- [ ] **First** write characterization tests against the current scoring/dedupe behaviour (copy the logic into `search.ts` verbatim, test it, *then* refactor). Cover: out-of-order keywords (`"bar foo"` matches `foo/bar/baz`), exact-name ranking, parent-over-child dedupe, child kept when it has more occurrences, create-option suppressed on exact path/name match, case-insensitivity, `validateFolderName` cases, `parseSettings` cases.
- [ ] `enum FolderDisplayMode` → `as const` object + union type (required for Node type stripping); stored values (`"default"|"recency"|"frequency"`) unchanged.
- [ ] Move to `SuggestModal<Item>` with the discriminated union (QUAL-3); separators only in the empty-query list (QUAL-7); unify recency/frequency; `renderMatches` with merged ranges.
- [ ] Accept: `npm test` green; `no-tfile-tfolder-cast` gone; identical ordering for the same queries (spot-check against the old build in a test vault).

### S4: Navigation and file explorer rewrite

Files: new `src/explorer.ts`, `src/folderSuggestModal.ts`.

- [ ] SEC-4: one guarded accessor for the explorer leaf + `revealInFolder`; no prototype enumeration; Notice when the explorer is unavailable (e.g. core plugin disabled).
- [ ] SEC-5: path-based selector scoped to the explorer leaf `containerEl`; drop ancestor click chain; expand target only (`is-collapsed` check) per `expandTargetFolder`.
- [ ] SEC-9/10: remove debug mode + `log()`; window timers; clear the highlight timer handle.
- [ ] Test duplicate folder names (`A/notes`, `B/notes`), deep nesting, explorer closed/collapsed sidebar, mobile (drawer), and a popout window.
- [ ] Accept: `prefer-active-doc`, `prefer-window-timers` warnings gone; §6 checks 1–4, 7 pass.

### S5: Settings tab and main cleanup

Files: `src/settingsTab.ts`, `src/main.ts`.

- [ ] QUAL-1: conditional rendering instead of `style.display`; re-render on mode change (`this.display()`).
- [ ] If D2 = 1.13: migrate to `getSettingDefinitions()` + `SettingFolderControl`, delete `FolderSelectionModal`. Otherwise keep the modal but drop its unused `plugin` param and use `getAllFolders(true)` so root is selectable.
- [ ] Remove debug toggle (D3); headings via `setHeading()` (already), sentence case text.
- [ ] Accept: `npx eslint .` → **0 errors, 0 warnings** (deliberate disables commented). `npm run typecheck` clean.

### S6: Release pipeline, metadata, docs

Files: `.github/workflows/*`, `.github/dependabot.yml`, `.github/FUNDING.yml`, `manifest.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `version-changelog.mjs`, `package.json`.

- [ ] CI-1…7 as listed. Release workflow: `npm ci --ignore-scripts` → `npm run lint && npm run typecheck && npm test && npm run build` → attest → draft release with `build/main.js`, `build/manifest.json`, `build/styles.css`.
- [ ] D1 identity changes; README: fork notice, what changed vs upstream, privacy note (history stored in `data.json`, no network access), remove stale `docs/implementation/SEARCH_IMPROVEMENTS.md` or update it to point at `search.ts` tests.
- [ ] `validate-manifest` / `validate-license` lint clean.
- [ ] Accept: tag a pre-release in the fork; workflow green; `gh attestation verify build/main.js --repo n0mu/obsidian-folder-navigator` succeeds; (if you have dashboard access) preview scan passes.

---

## 6. Manual test checklist (run in a throwaway vault after S2, S4, S5)

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
