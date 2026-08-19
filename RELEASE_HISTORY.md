# 桌面版发布记录

DeepSeek Harness 桌面应用（`apps/desktop`，`@deepseek-ai/dsh-desktop`）的版本维护台账。
每次发版必须在此追加一节（最新版在最前），并同步三件事：bump `apps/desktop/package.json` 的 version、
打 `desktop-v<version>` tag、在 GitHub Releases 创建「Desktop v<version>」并上传安装器。

## 维护规则

- 版本号一律递增 patch 位（如 1.0.1 → 1.0.2），不按 semver bump minor，即使包含新功能。
- 安装器产物命名 `dsh-setup-<version>-win-x64.exe`，位于 `apps/desktop/dist-release/`。
- 发版入口：双击根目录 `发布桌面版Release.bat`（即 `scripts/release-desktop.ps1`），先用 `-DryRun` 预检。
- 未登录 gh CLI 时脚本自动回退 REST API 通道，读取 `.github-release-token` 中的 PAT（repo 权限；该文件已入 .gitignore，切勿提交）。
- pre-push hook 会跑全仓 `pnpm run typecheck`，推送 tag 前确保其通过。
- 发版提交沿用 `chore(release): desktop v<version>` 格式。

## v1.0.8 — 2026-08-19（已发布）

tag `desktop-v1.0.8`；Release「Desktop v1.0.8」（https://github.com/LongYu12/deepseek-harness-desktop/releases/tag/desktop-v1.0.8）。
安装器 `dsh-setup-1.0.8-win-x64.exe`，143,804,760 字节，与远端校验一致。

### 新功能

- 插件热重载：插件页右上角「热重载」按钮，store patch 层变更立即生效，无需重启应用（`HotReloadAction`）。
- 插件导入 tab：支持 `dsh plugin [--profile <name>] add <spec>` 完整命令，或直接粘贴 registry 包名（如 `dshmarket`）、GitHub 仓库（`owner/repo`、`git+https://...`、`.git` 结尾链接）以及 `.tar.gz` 链接；安装进度实时展示（progress 事件）。
- 社区目录卡片：`local-plugin-store/` 本地商店索引内置 dshmarket、dsh-web-ui-all、dsh-usage-stats、dsh-skin-market 等社区插件卡片，随安装器分发。
- 路径打开能力重构：native path opener 从 host/apiproxy 迁移到 `packages/util/native-command`，Windows 无控制台宿主下不弹黑窗。

### 修复与收尾

- profile 组合测试覆盖导入命令解析与热重载路径。

### 发版清单

- [x] 安装器 `dsh-setup-1.0.8-win-x64.exe` 构建完成
- [x] tag `desktop-v1.0.8` 推送 origin
- [x] GitHub Release「Desktop v1.0.8」创建并上传安装器
- [x] 本节状态更新为已发布，补充 Release 链接与产物字节数

## v1.0.2 — 2026-08-17

状态：构建发版中

### 新功能

- Session 头部余额胶囊：会话头部展示 provider 余额查询结果（commit `563f6179bf`）。
- 插件商店 Web 界面：设置页新增「插件商店」标签，支持目录浏览、本地搜索、安装/卸载/更新（经 pnpm 与 profile bundle 层 reconcile）、插件条目启停（store patch 层热生效）与重启提示。
  - host 网关：`packages/host/plugin-store`（Remote 动词 `catalog`/`inventory`/`installBundle`/`removeBundle`/`updateBundle`/`setEntryEnabled`）。
  - client 界面：`packages/client/ui-settings-plugin-store`。

### 修复与收尾

- Client gateway 在每个命名空间保留裸 `install`/`remove`，store Remote 动词对称改名加 `Bundle` 后缀。
- store 配置 `indexUrl` 空串归一化为未设置，避免 patch 层默认空串触发 URL 解析失败。
- 新包源文件 LF 归一化；config catalog 重新生成并补齐中文侧索引条目。

### 发版清单

- [ ] 安装器 `dsh-setup-1.0.2-win-x64.exe` 构建完成
- [ ] tag `desktop-v1.0.2` 推送 origin
- [ ] GitHub Release「Desktop v1.0.2」创建并上传安装器
- [ ] 本节状态更新为已发布，补充 Release 链接与产物字节数

## v1.0.1 — 2026-08-17（已发布）

tag `desktop-v1.0.1`；Release「Desktop v1.0.1」（release id 371495727）。
安装器 `dsh-setup-1.0.1-win-x64.exe`，143,749,339 字节，与远端校验一致。

### 内容

- Windows 无控制台宿主下抑制 pwsh/子进程黑窗弹出（`CREATE_NO_WINDOW`，commit `70dc06d63b`）。
- 一键发版工具链：`发布桌面版Release.bat` + `scripts/release-desktop.ps1`（gh CLI 固定目录兜底探测、未登录回退 REST API、curl 断线重传进度条；commits `d968ede6c4`、`46deaa2272`）。

## 0.1.0-rc.5 — 2026-08-13（初始预览）

桌面壳首个可安装版本：Electron 桌面壳与 NSIS 打包管线（commit `bdcb360fce`），随 npm `dsh` 0.1.0-rc.5 序列发布。
