import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  addIcon,
  Platform,
} from "obsidian";
import cloneDeep from "lodash/cloneDeep";
import isEmpty from "lodash/isEmpty";
import feather from "feather-icons";

type DataSourceType = "not-selected" | "wttr" | "openweathermap";

interface CachedItem {
  source: DataSourceType;
  timestampInMs: number;
  info: string;
}
type CachedCallType = Partial<Record<DataSourceType, CachedItem>>;

interface WeatherPluginSettings {
  source: DataSourceType;
  cacheSeconds: number;
  addRibbon: boolean;
}

const DEFAULT_SETTINGS: WeatherPluginSettings = {
  source: "not-selected",
  cacheSeconds: 300,
  addRibbon: true,
};

const selectedIcon = feather.icons["sun"].toSvg({
  width: 100,
  height: 100,
});

/**
 * A trick from https://gist.github.com/liamcain/3f21f1ee820cb30f18050d2f3ad85f3f
 * @param plugin
 * @returns
 */
const monkeyPatchConsole = (plugin: Plugin) => {
  if (!Platform.isIosApp) {
    // we only need to get log from ios
    return;
  }

  const logFile = `${plugin.manifest.dir}/logs.txt`;
  const logs: string[] = [];
  const logMessages =
    (prefix: string) =>
    (...messages: unknown[]) => {
      logs.push(`\n[${prefix}]`);
      for (const message of messages) {
        logs.push(String(message));
      }
      plugin.app.vault.adapter.write(logFile, logs.join(" "));
    };

  console.debug = logMessages("debug");
  console.error = logMessages("error");
  console.info = logMessages("info");
  console.log = logMessages("log");
  console.warn = logMessages("warn");
};

export default class WeatherPlugin extends Plugin {
  settings: WeatherPluginSettings;
  cachedPrevCall: CachedCallType;
  weatherRibbon?: HTMLElement;
  commandEnabled: boolean;

  async onload() {
    monkeyPatchConsole(this);
    console.log("loading WeatherPlugin");
    await this.loadSettings();
    this.cachedPrevCall = {};
    this.weatherRibbon = undefined;
    this.commandEnabled = false;
    addIcon("weather", selectedIcon);

    if (this.settings.source !== "not-selected") {
      this.addWeatherCommand();
    }
    if (this.settings.addRibbon) {
      await this.addWeatherRibbon();
    }

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new WeatherSettingTab(this.app, this));
  }

  onunload() {
    console.log("unloading WeatherPlugin");
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * A trick from https://github.com/gavvvr/obsidian-imgur-plugin/blob/master/src/ImgurPlugin.ts ,
   * which is licensed under MIT License,
   * to get the
   */
  getEditor() {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf !== undefined && leaf !== null) {
      const view = leaf.view as MarkdownView;
      if (view !== undefined && view !== null) {
        const editor = view.editor;
        return editor;
      }
    }
    return undefined;
  }

  async addWeatherRibbon() {
    if (this.weatherRibbon !== undefined) {
      return;
    }
    if (this.settings.source === "not-selected") {
      return;
    }
    this.weatherRibbon = this.addRibbonIcon(
      "weather",
      "Insert Weather",
      async (event) => {
        const editor = this.getEditor();
        if (editor === undefined) {
          new Notice("No active editor, no output.");
          return;
        }
        const k = new Notice("Fetching weather...");
        try {
          const weatherInfo = await fetchWeather(
            this.settings.source,
            this.settings.cacheSeconds,
            this.cachedPrevCall
          );
          k.hide();
          editor.replaceRange(weatherInfo.info, editor.getCursor());
        } catch (e) {
          console.error(e);
          new Notice("Something goes wrong while fetching weather info.");
        }
      }
    );
  }

  /**
   * No removeRibbon, but we can detach it.
   * https://discord.com/channels/686053708261228577/707816848615407697/806904986839023616
   */
  removeWeatherRibbon() {
    if (this.weatherRibbon === undefined) {
      return;
    }
    this.weatherRibbon.detach();
    this.weatherRibbon = undefined;
  }

  addWeatherCommand() {
    if (this.commandEnabled) {
      return;
    }
    this.addCommand({
      id: "weather-insert",
      name: "Insert current weather",
      icon: "weather",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        // console.log(editor.getSelection());
        const k = new Notice("Fetching weather...");
        try {
          const weatherInfo = await fetchWeather(
            this.settings.source,
            this.settings.cacheSeconds,
            this.cachedPrevCall
          );
          k.hide();
          editor.replaceRange(weatherInfo.info, editor.getCursor());
        } catch (e) {
          console.error(e);
          new Notice("Something goes wrong while fetching weather info.");
        }
      },
    });

    this.addCommand({
      id: "weather-output-cache",
      name: "Output current cached weather info. For debugging purposes.",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        if (this.cachedPrevCall === undefined || isEmpty(this.cachedPrevCall)) {
          new Notice("No cached weather info, no output.");
        } else {
          const outputCode =
            "\n```json\n" +
            JSON.stringify(this.cachedPrevCall, null, 2) +
            "\n```\n";
          editor.replaceRange(outputCode, editor.getCursor());
        }
      },
    });

    this.commandEnabled = true;
  }

  /**
   * remove the commands.
   * A trick from https://liamca.in/Obsidian/API+FAQ/commands/unload+a+Command
   */
  removeWeatherCommand() {
    if (!this.commandEnabled) {
      return;
    }
    (this.app as any).commands.removeCommand(
      `${this.manifest.id}:weather-insert`
    );
    (this.app as any).commands.removeCommand(
      `${this.manifest.id}:weather-output-cache`
    );
    this.commandEnabled = false;
  }
}

const fetchWeather = async (
  source: DataSourceType,
  cacheSeconds: number,
  cachedPrevCall: CachedCallType
) => {
  const currTimestampMs = Date.now();
  if (
    cacheSeconds !== undefined &&
    cachedPrevCall !== undefined &&
    source in cachedPrevCall
  ) {
    const cached = cachedPrevCall[source];
    if (currTimestampMs <= cached.timestampInMs + cacheSeconds * 1000) {
      return cached;
    } else {
      delete cachedPrevCall[source];
    }
  }
  if (source === "wttr") {
    const res1 = await fetch("https://wttr.in/?format=4");
    const res2 = await res1.text();
    const newItem = {
      source: source,
      timestampInMs: currTimestampMs,
      info: res2,
    } as CachedItem;
    cachedPrevCall[source] = newItem;
    return newItem;
  } else if (source === "openweathermap") {
    throw Error(`not implemented for ${source} yet!`);
  } else {
    throw Error(`not implemented for ${source} yet!`);
  }
};

class WeatherSettingTab extends PluginSettingTab {
  plugin: WeatherPlugin;

  constructor(app: App, plugin: WeatherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h1", { text: `${this.plugin.manifest.name}` });

    new Setting(containerEl)
      .setName("Data Provider")
      .setDesc(
        createFragment((frag) => {
          frag.createEl("span", {
            text: "By selecting any third-party data provider, you agree to that provider's privacy policy and terms of use, and you also agree and consent that this plugin sends requests to the selected data provider to fetch the weather data, and stores some necessary information and login credentials locally.",
          });
        })
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("not-selected", "(no provider selected)");
        dropdown.addOption("wttr", "https://wttr.in/");
        // dropdown.addOption('openweathermap', 'https://openweathermap.org/');

        dropdown
          .setValue(this.plugin.settings.source)
          .onChange(async (val: DataSourceType) => {
            this.plugin.settings.source = val;
            await this.plugin.saveSettings();

            if (val === "not-selected") {
              this.plugin.removeWeatherCommand();
              this.plugin.removeWeatherRibbon();
            } else {
              this.plugin.addWeatherCommand();
              this.plugin.addWeatherRibbon();
            }
          });
      });

    new Setting(containerEl)
      .setName("Cache Time")
      .setDesc(
        "After one call of weather api, the result will be cached for some minutes locally."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("300", "5 minutes");
        dropdown.addOption("600", "10 minutes");

        dropdown
          .setValue(`${this.plugin.settings.cacheSeconds}`)
          .onChange(async (val: string) => {
            this.plugin.settings.cacheSeconds = parseInt(val);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Add Ribbon")
      .setDesc("Add sidebar ribbon or not?")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.addRibbon)
          .onChange(async (val: boolean) => {
            this.plugin.settings.addRibbon = val;
            await this.plugin.saveSettings();
            if (val) {
              await this.plugin.addWeatherRibbon();
            } else {
              this.plugin.removeWeatherRibbon();
            }
          });
      });

    containerEl.createEl("h2", { text: "License" });
    const licenseDiv = containerEl.createEl("div");
    licenseDiv.createEl("p", {
      text: "The source code of the plugin is released under Apache-2 license. See the repo for more information:",
    });
    licenseDiv.createEl("a", {
      text: this.plugin.manifest.authorUrl,
      href: this.plugin.manifest.authorUrl,
    });
  }
}
