# DeepSeek Harness

English | [中文](README.zh.md)

## Features added in this distribution (beyond upstream DeepSeek Harness)

> 本仓库在官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 基础上扩展，新增以下功能模块，随 Windows 桌面版（v1.0.9）与 Web UI 一起交付。

### 桌面版应用与欢迎界面

原生窗口承载 Web UI，目标机器无需安装 Node.js；新会话欢迎页展示当前模型与快捷入口：

![桌面版主界面](assets/feature-01-home.png)

### 插件商店

设置页新增「插件商店」标签：浏览官方与社区插件目录、本地搜索、一键安装/卸载/更新（经 `pnpm --profile bundle --reconcile`）、插件条目启停（store patch 层热生效），变更后提示重启：

![插件商店（官方目录）](assets/feature-02-store-official.png)

**推荐安装（社区已验证插件）**：

- `@linxin666/dsh-web-ui-all`：DSH Web UI 全家桶聚合插件——任务看板、git 图谱、宠物、远程 Web UI、实时统计（余额查看）与皮肤中心，一键安装。
- `dshmarket`：DSH 可视化插件市场——浏览、搜索并一键安装社区插件，提供侧边栏入口。
- `dsh-usage-stats`：DSH 用量统计——token 趋势、活跃热力图、模型用量拆分与导出。
- `dsh-skin-market`：皮肤市场——浏览并应用 Web 界面皮肤。
- `dsh-ivory`：Claude-inspired 主题插件，支持 light/dark/mobile 模式。

![插件商店（社区已安装）](assets/feature-03-store-installed.png)

### 插件导入

支持 `dsh plugin [--profile <name>] add <spec>` 完整命令，或直接粘贴 registry 包名（如 `dshmarket`）、GitHub 仓库（`owner/repo`、`git+https://...`、`.git` 结尾链接）以及 `.tar.gz` 链接；新 bundle 通过右上角「热重载」立即生效或重启生效：

![插件导入](assets/feature-04-plugin-import.png)

### 更多增强

- **插件热重载**：插件页右上角一键重载，store patch 层变更立即生效；桌面端在需要重启生效时自动重启应用（通过应用自身 exe 路径）。
- **会话头部余额胶囊**：展示 provider 余额查询结果。
- **一键发版工具链**：`发布桌面版Release.bat`（即 `scripts/release-desktop.ps1`）。

---

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

### Desktop app

The desktop app wraps the Web UI in a native window and needs no Node installation on the target machine. Build the installer from a repository checkout:

```sh
pnpm install
pnpm run desktop:build
```

Installers land in `apps/desktop/dist-release/` — an NSIS setup on Windows (`win-x64`), a dmg on macOS (`mac-arm64`). Run `pnpm run desktop:dev` to open the app against the source tree without packaging.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
