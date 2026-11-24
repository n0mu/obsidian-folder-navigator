import { Plugin, TFolder } from "obsidian";
import { SettingsTab } from "./settingsTab";
import { type PluginSettings, parseSettings } from "./settings";
import { FolderSuggestModal } from "./folderSuggestModal";
import { deleteFromHistory, recordVisit, renameInHistory } from "./history";
import { FolderRevealer } from "./explorer";

export default class FolderNavigatorPlugin extends Plugin {
    settings!: PluginSettings;
    revealer!: FolderRevealer;

    async onload() {
        await this.loadSettings();

        this.revealer = new FolderRevealer(this.app);
        this.register(() => this.revealer.cancel());

        this.addSettingTab(new SettingsTab(this.app, this));

        this.addCommand({
            id: "open-folder-navigator",
            name: "Navigate to folder",
            callback: () => {
                new FolderSuggestModal(this.app, this).open();
            },
        });

        // Keep visit history in sync with the vault so renamed folders keep
        // their history and deleted ones don't linger in data.json.
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (
                    file instanceof TFolder &&
                    renameInHistory(
                        this.settings.folderHistory,
                        oldPath,
                        file.path,
                    )
                ) {
                    this.persistSettings();
                }
            }),
        );
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (
                    file instanceof TFolder &&
                    deleteFromHistory(this.settings.folderHistory, file.path)
                ) {
                    this.persistSettings();
                }
            }),
        );
    }

    async loadSettings() {
        this.settings = parseSettings((await this.loadData()) as unknown);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /** Fire-and-forget save that reports failures instead of dropping them. */
    persistSettings(): void {
        this.saveSettings().catch((error: unknown) => {
            console.error("Folder Navigator: failed to save settings", error);
        });
    }

    recordFolderVisit(folder: TFolder): void {
        recordVisit(this.settings.folderHistory, folder.path, Date.now());
        this.persistSettings();
    }
}
