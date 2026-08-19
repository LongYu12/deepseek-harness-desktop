# Agent Note：插件商店热重组与安装失败可见性

Status: implemented

[English](2026-08-18-plugin-store-live-recomposition.md) | 中文

## Problem

[插件商店 Web 表层](../../implemented/feature/2026-08-17-plugin-store-web-surface.md)留下三个缺口。其一，bundle 安装/卸载/更新必须重启进程：bundle 组合在进程启动时即固定，因此 store 自己的变更操作上报 `restartNeeded`，尽管启停已通过补丁层 watcher 热生效。其二，安装失败不可见：商店 tab 把 notice 渲染在页面最底部、已安装区折叠线之下，且每个 catch 分支都只显示通用文案并丢弃底层错误。其三，大多数安装实际上都失败了：pnpm 11 只要解析出的依赖树含未批准的 build scripts 就硬失败（`ERR_PNPM_IGNORED_BUILDS`，exit 1），尽管包已写入 `node_modules` 与 `dependencies`，而 store 把所有非零退出码判为失败；目录中还有一个条目（`open-design`）的 registry 元数据损坏（`dist-tags.latest` 缺失），使它的 `pnpm add` 每次都失败。

## Decision

四项变更，逐一对应缺口。

**bundle 层变更经根 Include 热重放。** `dsh-app-boot` 导出 `PROFILE_COMPOSE_KEY` 与 `refreshProfileComposition(ctx, binName, compose)`：函数复用启动时的 Include entry（与 `watchUserPatches` 驱动的是同一个），通过 `entry.update({ config: { ...includeConfig, patches } })` 完整重放当前组合，返回的 promise 只在 Loader 完成树 diff 与应用之后 resolve，因此挂载条目的 `update()`/dispose 均已落定。`apps/cli/profile-boot` 的 `composeLive` 现在每次调用都从磁盘重读 profile——`loadProfile`（每次调用都重读）、store/用户/home 补丁层，最后是启动时解析的 overlays——而非返回启动时固定的 `composed.bundlePatches`，因此加入或移出 manifest 层列表的 bundle 立即进入下一次组合。插件商店在构造时探测 `PROFILE_COMPOSE_KEY`；每次 pnpm 变更成功后，若存在 composer 则 await 它：成功返回 `restartNeeded: false` 并附 "applied live" 消息，失败保留 `restartNeeded: true` 并附加失败原因（重启后生效）。没有 composer 的宿主（任何非 `runProfile` 启动）行为与之前完全一致。

**pnpm 11 的 build-script 硬失败被抑制。** 安装类变更（`add`/`install`）追加 `--ignore-scripts`；`remove` 与 `update` 不加，因为 pnpm 的严格 CLI 会拒绝命令未声明的选项（"Unknown option: 'ignore-scripts'"）。商店从不运行依赖安装脚本——执行 registry 中任意的 postinstall 代码是供应链风险——因此该 flag 零代价，且让此前包已写入后仍失败的同一棵依赖树 `pnpm add` 以 exit 0 完成。

**安装失败可见。** 商店 tab 的 notice 从页面底部移到工具栏正下方；`mutate`、`toggleEntry`、`openConfig` 的 catch 分支现在显示 `error.message` 而非通用文案，失败的 pnpm 或传输错误会报出自己的名字。

**损坏的 registry 元数据不再进入索引。** 本地索引移除 `open-design`（其 `dist-tags.latest` 在 registry 中缺失）；`refresh-index.mjs` 的 `existsOnRegistry` 现在要求 `dist-tags.latest` 与 `versions[latest]` 同时存在，此类包在抓取阶段即被排除，而非让之后的每次安装都失败。

## Alternatives considered

**变更后进程内重启桌面后端。** 拒绝：后端进程持有会话树，杀掉它会丢用户运行中的会话与窗口状态；实时树更新两者都保留。

**`restartNeeded` 作为唯一路径。** 拒绝：用户侧需求明确是不重启；composer 把重启标志保留为降级路径，而非默认路径。

**用 `--config.strictDepBuilds=false` 而非 `--ignore-scripts`。** 拒绝：它是 pnpm 11 特有的，而 `--ignore-scripts` 跨版本稳定，且与商店从不运行脚本的立场一致。

**静默重试或跳过失败的安装。** 拒绝：可见失败正是本次改动的要点；失败的变更必须在 notice 中点名原因。

## Consequences

在注册了 composer 的 profile 上，bundle 安装/卸载/更新热生效；store 的消息注明 "applied live"，UI 因此可以去掉重启提示。composer 缺失或拒绝时，变更仍成功写入磁盘，UI 报告重启并附原因，坏补丁永远不会被静默半应用。

Include 更新路径现在是承重扩展点：`refreshProfileComposition` 在每次 store 变更时重放整个补丁栈，任何组合缺陷都会表现为可见的 store 失败而非静默漂移。没有 CLI 宿主的 profile（测试、嵌入式启动）不受影响。

pnpm 从商店路径绝不执行依赖安装脚本：安装确定且供应链安全，代价是跳过那些 `postinstall` 确实需要做配置的包。

商店索引现在在抓取阶段自愈：registry 元数据无法解析出 `latest` 版本的包，在到达用户的安装按钮之前就被排除。
