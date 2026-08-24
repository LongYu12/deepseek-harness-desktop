# Agent Note：桌面端热重载通过应用自身可执行文件重启

Status: implemented

[English](2026-08-24-desktop-restart-hot-reload.md) | 中文

## 问题

插件商店顶部的热重载动作在宿主存在 live composer 时重新应用 profile patch 栈，否则返回 `restartNeeded: true` 并提示重启进程。在桌面应用里这个提示是一条死路：用户只能手动关闭窗口再重新启动可执行文件，界面上没有任何东西能代劳。桌面壳（`apps/desktop`）完全没有渲染进程到主进程的桥——没有 preload 脚本、没有 IPC——因此跑在 Electron 窗口里的 Web UI 无法请求壳自我重启。

## 决策

给桌面壳增加一个最小重启桥，并让热重载动作在宿主报告只有重启才能生效时使用它。

**桌面壳：preload + IPC 重启。** 新增 `apps/desktop/src/preload.cts`，通过 `contextBridge` 暴露 `window.desktopShell.restartApp()`；它编译为 CommonJS（`lib/preload.cjs`），因为沙箱化渲染进程无法加载 ESM preload 脚本，而 tsconfig 能识别 `.cts` 且不改动主进程的 ESM 输出。主进程注册 `ipcMain.handle('dsh:restart-app', ...)`：用 `app.getPath('exe')` 解析当前运行的可执行文件，先停止派生的子进程（backend 与本地商店）避免孤儿进程占用 profile 或端口，再 `app.relaunch({ execPath })` + `app.quit()`，保证新实例只在本实例完全退出后启动——与单实例锁无竞态。窗口现在加载该 preload；`electron-builder.yml` 已包含 `lib/**/*`，打包应用原样携带它。

**UI：live 应用不可行时重启。** `HotReloadAction` 接受可选的 `restartApp` 注入（纯 Web 部署下不存在）。当宿主 `hotReload` 结果携带 `restartNeeded` 时，动作显示"正在重启应用…"提示并触发 `restartApp()`；渲染进程会被重启拆除，因此该调用的拒绝是预期的拆除行为并被吞掉。注册方（`ui-settings-plugin-store` 的 `apply`）通过 `desktopShell()` 辅助函数检测桥，仅在存在时注入；Web 部署行为完全不变。文案在两种语言各新增一行"正在重启应用…"。

## 备选方案

**桌面端一律重启，跳过 live composer。** 拒绝：composer 让 bundle 变更在数秒内生效且不丢窗口或会话；无条件重启会在注册了 composer 的 profile 上回退该路径。

**直接 spawn 可执行文件然后退出。** 拒绝：分离式 spawn 与单实例锁竞态——新实例可能在旧实例仍持锁时启动然后退出，最终一个应用都不剩。`app.relaunch` 会把新实例推迟到本实例退出之后。

**ESM preload。** 拒绝：沙箱化 preload 脚本无法加载 ESM，而为此关闭沙箱会削弱渲染进程隔离。

## 影响

在桌面应用上，无法 live 生效的热重载现在会通过应用自身可执行文件路径自动重启，需要启动期组合变更的安装/卸载/更新不再把用户困在"请重启进程"的提示前。纯 Web 部署行为与之前完全一致。桌面壳拥有了第一个渲染进程到主进程的桥；未来的壳能力（窗口控制、更新）可以扩展同一个 `desktopShell` 表面。
