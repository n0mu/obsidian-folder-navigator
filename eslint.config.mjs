import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    // Build output and Node build/release scripts are not plugin code.
    globalIgnores([
        "node_modules",
        "build",
        "main.js",
        "esbuild.config.mjs",
        "version-bump.mjs",
        "version-changelog.mjs",
    ]),
    ...obsidianmd.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["eslint.config.*"],
                },
            },
        },
    },
    {
        // Unit tests run under Node's built-in runner, not inside Obsidian.
        files: ["test/**/*.ts"],
        rules: {
            "@typescript-eslint/no-floating-promises": "off", // node:test's test() returns a promise the runner tracks
            "obsidianmd/no-nodejs-modules": "off",
        },
    },
]);
