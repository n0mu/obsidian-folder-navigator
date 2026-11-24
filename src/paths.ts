// Validation for user-typed folder names. Pure, no Obsidian runtime imports.

export type FolderNameResult =
    { ok: true; path: string } | { ok: false; reason: string };

// Characters Obsidian refuses in file names, which are also invalid on Windows
// or Android; plus ASCII control characters.
// eslint-disable-next-line no-control-regex -- control characters are matched deliberately, to reject them
const INVALID_CHARS = /[\\:*?"<>|\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Validate a folder path relative to the creation location. `/` separates
 * nested folders; leading, trailing and repeated slashes are ignored.
 * Returns the cleaned relative path, or a reason suitable for a Notice.
 */
export function validateFolderName(input: string): FolderNameResult {
    const segments = input
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    if (segments.length === 0) {
        return { ok: false, reason: "the folder name is empty" };
    }

    for (const segment of segments) {
        if (segment.startsWith(".")) {
            return {
                ok: false,
                reason: `"${segment}" starts with a dot (hidden from Obsidian, or a relative path)`,
            };
        }
        if (INVALID_CHARS.test(segment)) {
            return {
                ok: false,
                reason: `"${segment}" contains a character that isn't allowed (\\ : * ? " < > |)`,
            };
        }
        if (segment.endsWith(".")) {
            return {
                ok: false,
                reason: `"${segment}" ends with a dot, which Windows doesn't allow`,
            };
        }
        if (WINDOWS_RESERVED.test(segment)) {
            return {
                ok: false,
                reason: `"${segment}" is a reserved name on Windows`,
            };
        }
    }

    return { ok: true, path: segments.join("/") };
}
