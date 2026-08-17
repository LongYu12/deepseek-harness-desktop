# Agent Note: Electron 桌面壳分发 dsh web 后端

Status: implemented

[English](2026-08-14-electron-desktop-shell-distribution.md) | 中文

## Problem

harness 目前经由 npm 与[单文件可执行 SDK 运行时](2026-07-10-single-file-executable-sdk-runtime-distribution.md)分发;两条路线都是终端形态,且 single-exe 路线把 Windows 列为非目标。产品受众需要的是可双击打开、带图形界面、目标机器无需安装 Node、覆盖 Windows 与 macOS、以 setup 安装器交付的桌面应用——这些现有路线都不提供。

`dsh web` profile 已经把完整产品跑成本地 Node HTTP 服务器加出厂 Web UI。于是桌面问题收敛为:把这个后端原封不动装进安装器、在无外部 Node 的环境里运行、再套一个窗口——而不是把产品分叉成第二套 UI 实现。

## Decision

`apps/desktop`(`@deepseek-ai/dsh-desktop`,private 工作区成员)是一个 Electron 壳,主进程把真正的 `dsh` 后端 spawn 为子进程:`spawn(process.execPath, [bin.js, '--profile', 'web', '--port', '0'], { env: { ELECTRON_RUN_AS_NODE: '1' } })`。`ELECTRON_RUN_AS_NODE` 让 Electron 自带的 Node 运行后端,安装器因此不再捆绑独立的 Node 运行时。壳监听子进程 stdout 上文档化的 supervisor 就绪行 `dsh web: http://127.0.0.1:<port>`(`--port 0` 时打印的端口即 OS 分配的端口),随后在该 URL 上打开 `BrowserWindow`。单实例锁防止重复启动;window-all-closed 与 quit 都会清理后端的整个进程树(Windows 用 `taskkill /t /f`,其余平台 SIGTERM)。

后端以无符号链接的依赖闭包形式交付,走与 single-exe 管线相同的、已实测的 `pnpm deploy --legacy --prod` 路线。deploy、hoist 还原与链接物化步骤放在两条管线共同调用的共享模块 `scripts/deploy-closure.ts` 里;`scripts/build-desktop.ts` 把闭包落到 `apps/desktop/backend`(并剔除 `.pdb` 调试符号),再由 `afterPack` 钩子(`apps/desktop/after-pack.cjs`)把它拷进 asar 之外的 `resources/dsh-backend/`,asar 里只有壳自身的 `lib/`。闭包不能走 `extraResources`:electron-builder 的资源过滤器会无条件跳过被拷贝树的根 `node_modules`。开发模式(`desktop:dev`)跳过打包,直接 spawn 源码树的 `apps/cli/lib/bin.js`;`DSH_DESKTOP_BACKEND_BIN` 可覆盖 bin 路径。打包步骤始终传入 `--publish never`,因为 electron-builder 会把 CI 环境当作对发布主机的隐式发布请求。

闭包部署有两个管线必须设防的副作用。deploy 的内部 production install 会修剪整个工作区的 devDependencies,因此管线设置 `--config.ignore-scripts=true`(根 postinstall 的 lefthook 导入容忍这次修剪),并在 staging 之后重新执行 `pnpm install` 恢复开发者检出。legacy deploy 还会漏掉未声明的 peer 与仅靠 override 链接存活的 vendor 包,因此 `deploy-closure.ts` 会把每个缺失的 `@deepseek-ai` 包从其工作区构建产物复制进来——lib-main 包复制 `package.json` 加 `lib/`——并迭代直到 staged 树不再声明任何未满足的 workspace 作用域依赖。

闭包内的原生 addon 必须在 Electron ABI 下保持 N-API 稳定,出厂集合满足这一点:koffi 要求 N-API ≥ 8 且经由 `process.resourcesPath` 解析二进制,sharp 是 N-API,node-pty 随包分发各平台预编译产物,并有 `patches/node-pty@1.1.0.patch` 提供的 `DSH_NODE_PTY_SPAWN_HELPER` helper 旁路。管线中不存在 electron-rebuild 步骤。N-API 稳定是必要条件而非充分条件:Electron 的 NAPI 层拒绝 external ArrayBuffer,因此 `koffi.view()` 在 `ELECTRON_RUN_AS_NODE` 下会以 `napi_fatal_error` 中止进程;Win32 文件夹对话框绑定改为用定长 `char16` 数组解码读取所选路径(`dsh-host-directory-picker-native` 的 `readUtf16`),这条路径 Electron 的 NAPI 层接受。

`electron-builder` 首发两个目标:`win-x64` NSIS(安装器允许选择安装目录)与 `mac-arm64` dmg + zip,不签名(`identity: null`),无自动更新。根 scripts `desktop:dev` 与 `desktop:build`(`--targets=win-x64,mac-arm64`)驱动 `scripts/build-desktop.ts`;安装包落在 `apps/desktop/dist-release/`。应用图标以 `apps/desktop/build/icon.png` 交付(吉祥物插画,已去除生成器水印),electron-builder 由它派生各平台图标。首启的 API Key 录入复用现有 Web 设置页,用户数据留在 `$DSH_HOME`,卸载器不触碰它。

## Alternatives considered

- **在后端旁捆绑独立的 Node 运行时**:否决——Electron 自带 Node 运行时,`ELECTRON_RUN_AS_NODE` 免费复用它;第二个运行时徒增体积、版本漂移与独立的供应链。
- **在渲染进程里用 `file://` 或自定义 scheme 承载 Web UI**:否决——它把服务路径(静态服务、websocket 下行、host API 代理语义)分叉成第二个事实来源;加载真实的 `dsh web` HTTP 服务器使桌面与浏览器语义在构造上完全一致。
- **复用 single-exe 可执行文件作为桌面后端载体**:否决——single-exe 路线内嵌自己的 Node 且把 Windows 列为非目标;两条管线改为通过 `scripts/deploy-closure.ts` 共享闭包部署步骤。
- **用 electron-rebuild 按 Electron ABI 重编译原生 addon**:否决——所有出厂 addon 都是 N-API 稳定的(见上),重编译买不到任何正确性,只增加一个脆弱的构建步骤;该要求改在闭包构建脚本里声明。
- **Tauri 或原生 webview 外壳**:否决——后端仍然需要一个 Node 运行时,正好把 Electron 已经携带的东西再引入一遍,外加一条仓库里本不存在的第二工具链。

## Consequences

- 安装包背负 Electron 的物理体积下限(win-x64 NSIS 实测约 137 MB);这条路线上没有更小的载体。
- 现在有两个运行时载体——独立 `dsh web` 与 Electron 子进程——运行同一棵代码树;后端行为必须保持 UI 无关,就绪判定钉在两个载体都会打印的 stdout 行上。
- 构建必须在目标平台上进行,因为平台条件依赖的 addon 只为宿主解析:win-x64 在 Windows 上构建,mac-arm64 在 macOS 上构建。
- 后端可达的 koffi 代码必须避开 external ArrayBuffer 类 API(目前只有 `koffi.view`):它们在纯 Node 下正常、只在 Electron 的 NAPI 层下中止,因此回归只会在桌面载体上暴露。
- macOS 产物未签名;在加入签名证书与公证之前,用户会看到 Gatekeeper 提示。
- npm 发布与 Python SDK exe 管线均未改动;桌面管线与它们并存,只共享闭包部署模块。
- deploy 会通过修剪 devDependencies 改动开发者检出;任何复用 `deploy-closure.ts` 的管线都必须在 staging 后用 `pnpm install` 恢复它们。
