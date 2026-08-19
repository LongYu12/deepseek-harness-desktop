# Agent Note：插件商店导入命令、实时进度与手动热重载

Status: implemented

[English](2026-08-19-plugin-store-import-commands-and-live-progress.md) | 中文

## Problem

[插件商店 Web 界面](../../implemented/feature/2026-08-17-plugin-store-web-surface.md)及其[实时重组](../../implemented/feature/2026-08-18-plugin-store-live-recomposition.md)把导入通道收得很窄，且变更过程没有任何反馈。`importBundle` 只接受 git 仓库 spec，registry 包与 tarball URL 只能绕过商店手动安装。每次变更（卡片安装、卡片卸载、导入）都在不可见地运行 pnpm：一次漫长的 `pnpm add` 只显示一个忙碌标签，没有任何 stderr 输出，用户无法区分卡住的网络拉取与正常进行中的操作。实时 composer 也没有手动重放入口，因此一次降级为"需要重启"的实时应用无法从界面重试。随包目录只列出三个官方 bundle，社区用户没有可安装的东西。此外，导入落在兄弟 tab 中后，商店 tab 的已安装列表会一直过期，直到设置对话框重新打开。

## Decision

六项改动，每项对应一个缺口。

**命令格式导入。** `parsePluginImportCommand` 把输入拆成 `dsh plugin [--profile <name>] add <spec>`（或裸 `<spec>`），`resolveImportSpec` 把 spec 归类为 registry 包名、git 仓库形式或 https tarball URL（`.tar.gz`），每一种都由白名单正则校验，排除所有 shell 元字符，因此 spec 永远无法逃出 pnpm 参数。`importBundle` 拒绝指向与运行中 profile 不同的命令——商店只变更自己启动所在的 profile——然后用解析后的 spec 执行 `pnpm add`。registry 目标按名称安装并直接参与 bundle 检查；git 与 tarball 目标按 spec 安装，bundle 检查在 pnpm 解析出包名之后进行。install/remove/update 动词只接受 registry 包名的限制不变。

**流式变更进度。** 变更过程中 pnpm 的每一行 stderr 都作为 `plugin-store/progress`（`{ operation, target, line }`）事件发出，其中 `target` 是该变更解析出的 registry 名称、git spec 或 tarball URL。抛异常的进度观察者会被隔离：进度是展示面，不能中断正在产生这些行的 pnpm 变更。`api-remotes` 的转发事件白名单（`API_REMOTE_FORWARDED_EVENTS`）加入该事件，复用现有 Host→consumer 扇出链路投递给 `ctx.remote.$on` 订阅者。

**进度展示面。** 商店 tab 按目标保留最新一行并渲染在忙碌卡片内；导入 tab 在变更进行中于导入表单下方渲染解析出的目标与最新一行。两个展示面在行到达时只保留最后一行，因为快速的 pnpm 会发出大量行，渲染追不上。

**手动热重载。** `hotReload` 按需重新运行已启动界面的实时 profile composer 并报告结果；没有 composer 的宿主返回 `restartNeeded` 并说明原因。客户端把它注册为 `settings.action` 槽位 `plugin-store-hot-reload`（order 10），在设置界面渲染一个头部操作，用 status 展示结论。

**更丰富的目录。** `dsh-host-plugin-store` 的 `BUILTIN_CATALOG` 与本地商店索引（`local-plugin-store/index.json`，由 `local-plugin-store/serve.mjs` 提供）新增五个精选社区条目：`dshmarket`、`@linxin666/dsh-web-ui-all`、`dsh-usage-stats`、`dsh-skin-market` 与 `dsh-at-file` v0.6.3 tarball——都能像官方 bundle 一样经商店安装与卸载。

**导入驱动的清单刷新。** 客户端在浏览器插件里注册一个本地"清单已变更"总线：导入 tab 在成功导入后通知它，商店 tab 订阅并重新拉取，因此在对话框保持打开时导入的 bundle 就能加入已安装列表。

## Alternatives considered

**每次变更后自动重载而不是手动操作。** 已拒绝：composer 路径已经在 `runPnpmMutation` 内部自动执行；头部操作服务于自动应用失败后的降级场景，以及变更路径先于 composer 出现的宿主。

**通过变更响应拉取进度而不是事件。** 已拒绝：响应在 pnpm 退出时才到达，无法流式传输行；转发事件通道已存在，是通往浏览器的唯一实时通道。

**导入运行期间定时重新拉取商店 tab。** 已拒绝：通知总线只在关键状态转换时触发一次，空闲时零成本。

## Consequences

用户可以把五种文档化的导入命令形式中的任意一种粘贴进导入 tab，并实时观看 pnpm 输出；registry、git 与 tarball 目标都通过同一套守卫、进度、reconcile 与重启标记管道落入 profile。卡片安装与卸载显示同样的实时行，头部热重载操作无需重启进程即可重试失败的实时应用。

`plugin-store/progress` 事件现在是承重的线上名字：转发它只是白名单中的一个条目，任何该事件的消费者都必须保持 `{ operation, target, line }` 载荷，因为两个商店展示面与 e2e 通道都依赖它。

目录是精选而非抓取：每个条目都经过人工挑选，tarball 导入仍走 pnpm 解析，因此失败的源会让导入可见地失败，而不是半安装。
