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
]);
