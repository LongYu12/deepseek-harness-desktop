# @deepseek-ai/dsh-host-plugin-store

[English](README.md) | 中文

当前 profile 的插件商店网关。`PluginStoreGateway` 注册 `pluginStore` 服务并发布九个生成的 direct Remote：`pluginStore/catalog`、`pluginStore/inventory`、`pluginStore/installBundle`、`pluginStore/importBundle`、`pluginStore/removeBundle`、`pluginStore/updateBundle`、`pluginStore/setEntryEnabled`、`pluginStore/openStoreConfig` 与 `pluginStore/hotReload`（registry 变更动词带 `Bundle` 后缀，因为 Client 网关在每个 Remote 命名空间上保留了裸 `install` 与 `remove`；`importBundle` 改收导入命令 `dsh plugin [--profile <name>] add <spec>` 或裸 spec）。目录默认提供随包发布的官方 bundle 与精选社区条目内置索引；设置 `indexUrl` Config 后改为拉取同 schema 的远程 JSON，任何远程失败（非 OK 状态、JSON 损坏或 schema 违规）都直接报错，不静默回退。清单把 profile manifest 的 `dsh.profile.bundles` 层、各包已安装版本与 Loader 条目状态合并，并对照进程启动时的快照标记 `restartNeeded`，因为 bundle 组合在进程启动时即固定。条目启用状态是投影值：store 层的停用标记在写入返回时即计入上报状态，先于补丁层在 Loader 上的 HMR 重组。

变更操作在 profile 目录（Loader `baseUrl`，缺失时 fail loud）内 spawn `pnpm`，复用 [`dsh-app-boot`](../../boot/app-boot/README.md) 共享的 `reconcileBundles` 核心写回 `dsh.profile.bundles` 层，且只接受 registry 包名——路径与 tarball spec 在 spawn 前就被拒绝。`importBundle` 是专门的导入路径：它解析导入命令或裸 spec，拒绝指向与运行中 profile 不同的命令，并把 spec 解析为受白名单保护的 registry 包名、git 仓库形式（`github:owner/repo`、裸 `owner/repo`，或 `git+https:`/`git+ssh:`/`https:` 且以 `.git` 结尾的 URL，可加 `#ref` 后缀）或 https tarball URL（`.tar.gz`）；registry 目标按名称安装，git 与 tarball 目标按 spec 安装、bundle 检查在 pnpm 解析出包名后进行，解析出的 bundle 列表一旦变化即标记需要重启。启停走 store 专属补丁层 `cordis.store.patch.yml`（与用户补丁文件并列）：`setEntryEnabled` 在其中写入或删除 `{ id, disabled: true }` 行，CLI watcher 会热重组该变更，因此启停无需重启，而安装/卸载/更新/导入需要。`openStoreConfig` 是配置快捷入口：它物化 profile 的用户补丁层 `cordis.patch.yml`（缺失时先写入空行表种子）并交给文本编辑器打开；在其中添加 `{ id: plugin-store, config: { ... } }` 行即可覆盖 `indexUrl` 等 store 可调项。

变更过程中 pnpm 的每一行 stderr 都作为 `plugin-store/progress` 事件（`{ operation, target, line }`）发出，并经 `api-remotes` 白名单转发给消费者，因此商店展示面可以按变更解析出的目标流式展示实时输出。`hotReload` 按需重新运行已启动界面的实时 profile composer：没有 composer 的宿主返回 `restartNeeded` 并说明原因，失败的实时应用保留标记并点名失败原因，界面可从头部操作重试应用而无需重启进程。

## 模型体验

无。本包是纯 Host 侧商店网关，不注册任何 prompt、tool、消息或 provider 请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与后续工作

- **registry 包名，导入除外** — 安装/卸载/更新只接受裸 registry 包名，不接受版本范围、路径或 tarball spec；`importBundle` 是专门的导入路径，接受 registry 包名、git 仓库形式与 https tarball URL。版本选择遵循 pnpm 默认解析。
- **无在线发现** — 目录只通过内置索引或配置的 `indexUrl` 扩展，不提供 registry 搜索端点。
- **时点快照** — 清单不订阅 manifest 或 Loader 变化；客户端在变更完成后自行重新拉取。
