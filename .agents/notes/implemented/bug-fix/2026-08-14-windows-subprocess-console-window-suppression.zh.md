# Agent Note: Windows subprocess console-window suppression

Status: implemented

[English](2026-08-14-windows-subprocess-console-window-suppression.md) | 中文

## Problem

[桌面壳](../architecture/2026-08-14-electron-desktop-shell-distribution.md)以 `ELECTRON_RUN_AS_NODE` 运行 `dsh` 后端——一个 GUI 子系统进程,没有附加任何控制台。在 Windows 上,无控制台的父进程派生控制台子系统子进程(`pwsh.exe`、打包的 `rg.exe`、`taskkill.exe`)时,除非用 `CREATE_NO_WINDOW` 抑制,否则系统会为子进程新建一个可见的控制台窗口;于是每条 shell 命令、每次搜索、每次进程树清理都会在产品界面上闪出一个黑色控制台窗口。终端载体的运行从不复现此缺陷,因为后端继承了启动终端的控制台,子进程直接共享它。

## Decision

subprocess 管线中所有 Windows 可达的派生点都设置 Node 的 `windowsHide: true`(映射为 `CREATE_NO_WINDOW`):seam 在 `dsh-subprocess-local/spawn.ts` 的唯一派生点(`spawnSubprocess`)、其 `taskkillProcessTree` 兜底,以及桌面壳退出时的 `taskkill`。该标志在 POSIX 上无效。ACL 沙箱的被限制子进程获得同样的抑制:早前"`CREATE_NO_WINDOW` 子进程会以 `STATUS_DLL_INIT_FAILED` 死亡"的发现与本移植从 restricting 列表排除的控制台登录 SID 绑定,受控复验(两种 stdio 形态、两种限制模式、无控制台宿主)显示该标志工作正常,因此 `dsh-sandbox-windows-acl/spawn.ts` 检查 `GetConsoleWindow`,恰好当宿主无控制台时(桌面载体形态)追加 `CREATE_NO_WINDOW`;有控制台的宿主仍让子进程附着其控制台,windows-acl runner 进程本身以隐藏方式运行。

## Alternatives considered

- **只在桌面壳里设置 `windowsHide`**:否决——桌面壳够不到的派生点正是 subprocess seam 本身;标志应放在所有载体的派生都汇聚之处,且终端载体不受它影响。
- **在 Windows 上用 `detached: true` 脱离控制台**:否决——`detached` 改变进程树清理语义(seam 正是因 Windows 子进程保持附着才通过根 pid 走 `taskkill /T` 终止),而且它仍未规定控制台分配行为。
- **启动时为后端分配一个控制台再隐藏它**:否决——"先分配、再隐藏"的两段窗口状态比从不分配更脆弱,而 `CREATE_NO_WINDOW` 已在每个派生点直接表达意图。

## Consequences

- 桌面载体的工具运行不再为 seam 派生的子进程闪出控制台窗口;POSIX 与终端载体行为不变。
- 桌面载体的沙箱 shell 命令也不再出现控制台窗口:被限制子进程从无控制台的 runner 宿主继承 `CREATE_NO_WINDOW` 抑制。`CREATE_NEW_CONSOLE` 在该限制下仍未测试,本移植从不请求它。
