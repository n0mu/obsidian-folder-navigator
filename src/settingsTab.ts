import {
    type App,
    FuzzySuggestModal,
    Modal,
    Notice,
    PluginSettingTab,
    Setting,
    type SettingDefinitionItem,
    type TFolder,
    requireApiVersion,
} from "obsidian";
import type FolderNavigatorPlugin from "./main";
import { FolderDisplayMode } from "./settings";
import { createHistory } from "./history";

const ROOT_LABEL = "/ (Root)";

/**
 * Obsidian 1.13 added declarative settings (searchable, rendered by the app)
 * and changed sliders and buttons. minAppVersion is 1.7.2 (decision D2), so
 * older versions get the classic `display()` path from the same rows.
 */
const DECLARATIVE_SETTINGS = "1.13.0";

/** One settings row, rendered by either path. */
interface Row {
    name: string;
    desc: string;
    /** Re-evaluated on every render; hidden rows are skipped. */
    visible?: () => boolean;
    /** Add the row's controls. Name and description are already set. */
    render: (setting: Setting) => void;
}

interface Group {
    heading: string;
    rows: Row[];
}

/** Pick the folder new folders are created in (the vault root included). */
class FolderSelectionModal extends FuzzySuggestModal<TFolder> {
    private onSelect: (folder: TFolder) => void;

    constructor(app: App, onSelect: (folder: TFolder) => void) {
        super(app);
        this.onSelect = onSelect;
        this.setPlaceholder("Search for a folder...");
    }

    getItems(): TFolder[] {
        return this.app.vault.getAllFolders(true);
    }

    getItemText(folder: TFolder): string {
        return folder.isRoot() ? ROOT_LABEL : folder.path;
    }

    onChooseItem(folder: TFolder): void {
        this.onSelect(folder);
    }
}

/** Asks before clearing the visit history. */
class ConfirmResetModal extends Modal {
    private onConfirm: () => void;

    constructor(app: App, onConfirm: () => void) {
        super(app);
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        this.titleEl.setText("Reset folder history");
        this.contentEl.createEl("p", {
            text: "Are you sure? This will permanently delete all folder navigation history including recently visited and frequently used folder data.",
            cls: "mod-warning",
        });
        const buttons = this.contentEl.createDiv({
            cls: "modal-button-container",
        });
        buttons
            .createEl("button", { text: "Cancel" })
            .addEventListener("click", () => this.close());
        buttons
            .createEl("button", {
                text: "Reset folder history",
                cls: "mod-warning",
            })
            .addEventListener("click", () => {
                this.close();
                this.onConfirm();
            });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export class SettingsTab extends PluginSettingTab {
    plugin: FolderNavigatorPlugin;

    constructor(app: App, plugin: FolderNavigatorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** Obsidian 1.13+: rendered and indexed for settings search by the app. */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return this.groups().map((group) => ({
            type: "group",
            heading: group.heading,
            items: group.rows.map((row) => ({
                name: row.name,
                desc: row.desc,
                visible: row.visible ?? true,
                render: row.render,
            })),
        }));
    }

    /** Obsidian below 1.13 (1.13+ uses getSettingDefinitions instead). */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        for (const group of this.groups()) {
            new Setting(containerEl).setName(group.heading).setHeading();
            for (const row of group.rows) {
                if (row.visible && !row.visible()) continue;
                row.render(
                    new Setting(containerEl)
                        .setName(row.name)
                        .setDesc(row.desc),
                );
            }
        }
    }

    private groups(): Group[] {
        const { settings } = this.plugin;
        const inMode = (mode: FolderDisplayMode) => () =>
            settings.folderDisplayMode === mode;

        return [
            {
                heading: "Folder display",
                rows: [
                    {
                        name: "Display priority",
                        desc: "Control which folders appear at the top of the suggestion list before searching",
                        render: (setting) =>
                            setting.addDropdown((dropdown) =>
                                dropdown
                                    .addOptions({
                                        [FolderDisplayMode.DEFAULT]:
                                            "Default order (alphabetical)",
                                        [FolderDisplayMode.RECENCY]:
                                            "Recently visited first",
                                        [FolderDisplayMode.FREQUENCY]:
                                            "Frequently visited first",
                                    })
                                    .setValue(settings.folderDisplayMode)
                                    .onChange((value) => {
                                        settings.folderDisplayMode =
                                            value as FolderDisplayMode;
                                        this.save();
                                        this.refresh(); // show this mode's options
                                    }),
                            ),
                    },
                    {
                        name: "Recent folders to show",
                        desc: "Number of recently visited folders to display at the top when using 'Recently visited first' mode",
                        visible: inMode(FolderDisplayMode.RECENCY),
                        render: (setting) =>
                            this.addSlider(
                                setting,
                                [1, 20, 1],
                                () => settings.recentFoldersToShow,
                                (v) => (settings.recentFoldersToShow = v),
                            ),
                    },
                    {
                        name: "Frequent folders to show",
                        desc: "Number of frequently visited folders to display at the top when using 'Frequently visited first' mode",
                        visible: inMode(FolderDisplayMode.FREQUENCY),
                        render: (setting) =>
                            this.addSlider(
                                setting,
                                [1, 20, 1],
                                () => settings.frequentFoldersToShow,
                                (v) => (settings.frequentFoldersToShow = v),
                            ),
                    },
                    {
                        name: "Maximum results",
                        desc: "Maximum number of folders to show in search results",
                        render: (setting) =>
                            this.addSlider(
                                setting,
                                [5, 50, 5],
                                () => settings.maxResults,
                                (v) => (settings.maxResults = v),
                            ),
                    },
                    {
                        name: "Reset folder history",
                        desc: "Clear the tracked history of visited folders. Warning: This will remove all recency and frequency data.",
                        visible: () =>
                            settings.folderDisplayMode !==
                            FolderDisplayMode.DEFAULT,
                        render: (setting) =>
                            setting.addButton((button) => {
                                button.setButtonText("Reset").onClick(() => {
                                    new ConfirmResetModal(this.app, () => {
                                        settings.folderHistory =
                                            createHistory();
                                        this.save();
                                        new Notice(
                                            "Folder history has been reset",
                                        );
                                    }).open();
                                });
                                if (requireApiVersion(DECLARATIVE_SETTINGS)) {
                                    button.setDestructive().setCta();
                                } else {
                                    button.buttonEl.addClass("mod-warning");
                                }
                            }),
                    },
                ],
            },
            {
                heading: "Folder creation",
                rows: [
                    {
                        name: "Default location for new folders",
                        desc: "Choose where new folders will be created when using the 'Create folder' option. Default is the vault root.",
                        render: (setting) =>
                            setting
                                .addButton((button) =>
                                    button
                                        .setButtonText(
                                            settings.newFolderLocation ||
                                                ROOT_LABEL,
                                        )
                                        .onClick(() => {
                                            new FolderSelectionModal(
                                                this.app,
                                                (folder) => {
                                                    settings.newFolderLocation =
                                                        folder.isRoot()
                                                            ? ""
                                                            : folder.path;
                                                    this.save();
                                                    button.setButtonText(
                                                        settings.newFolderLocation ||
                                                            ROOT_LABEL,
                                                    );
                                                },
                                            ).open();
                                        }),
                                )
                                .addExtraButton((button) =>
                                    button
                                        .setIcon("reset")
                                        .setTooltip("Reset to root folder")
                                        .onClick(() => {
                                            settings.newFolderLocation = "";
                                            this.save();
                                            this.refresh();
                                        }),
                                ),
                    },
                ],
            },
            {
                heading: "Folder navigation",
                rows: [
                    {
                        name: "Expand target folder on navigation",
                        desc: "When enabled, folders will be automatically expanded when you navigate to them",
                        render: (setting) =>
                            setting.addToggle((toggle) =>
                                toggle
                                    .setValue(settings.expandTargetFolder)
                                    .onChange((value) => {
                                        settings.expandTargetFolder = value;
                                        this.save();
                                    }),
                            ),
                    },
                ],
            },
        ];
    }

    /**
     * A slider that saves on change. From 1.13 sliders show their value
     * inline; before that the value is shown in a label next to it (the old
     * setDynamicTooltip() is deprecated).
     */
    private addSlider(
        setting: Setting,
        [min, max, step]: [number, number, number],
        get: () => number,
        set: (value: number) => void,
    ): void {
        setting.addSlider((slider) => {
            const label = requireApiVersion(DECLARATIVE_SETTINGS)
                ? null
                : setting.controlEl.createSpan({
                      cls: "fn-slider-value",
                      text: String(get()),
                  });
            slider
                .setLimits(min, max, step)
                .setValue(get())
                .onChange((value) => {
                    set(value);
                    this.save();
                    label?.setText(String(value));
                });
        });
    }

    /** Re-render after a change that shows or hides rows. */
    private refresh(): void {
        if (requireApiVersion(DECLARATIVE_SETTINGS)) {
            this.update();
        } else {
            this.display();
        }
    }

    private save(): void {
        this.plugin.persistSettings();
    }
}
