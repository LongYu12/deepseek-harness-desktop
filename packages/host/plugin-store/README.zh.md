# @deepseek-ai/dsh-host-plugin-store

[English](README.md) | 中文

当前 profile 的插件商店网关。`PluginStoreGateway` 注册 `pluginStore` 服务并发布六个生成的 direct Remote：`pluginStore/catalog`、`pluginStore/inventory`、`pluginStore/installBundle`、`pluginStore/removeBundle`、`pluginStore/updateBundle` 与 `pluginStore/setEntryEnabled`（变更动词带 `Bundle` 后缀，因为 Client 网关在每个 Remote 命名空间上保留了裸 `install` 与 `remove`）。目录默认提供随包发布的官方 bundle 内置索引；设置 `indexUrl` Config 后改为拉取同 schema 的远程 JSON，任何远程失败（非 OK 状态、JSON 损坏或 schema 违规）都直接报错，不静默回退。清单把 profile manifest 的 `dsh.profile.bundles` 层、各包已安装版本与 Loader 条目状态合并，并对照进程启动时的快照标记 `restartNeeded`，因为 bundle 组合在进程启动时即固定。

变更操作在 profile 目录（Loader `baseUrl`，缺失时 fail loud）内 spawn `pnpm`，复用 [`dsh-app-boot`](../../boot/app-boot/README.md) 共享的 `reconcileBundles` 核心写回 `dsh.profile.bundles` 层，且只接受 registry 包名——路径、git 与 tarball spec 在 spawn 前就被拒绝。启停走 store 专属补丁层 `cordis.store.patch.yml`（与用户补丁文件并列）：`setEntryEnabled` 在其中写入或删除 `{ id, disabled: true }` 行，CLI watcher 会热重组该变更，因此启停无需重启，而安装/卸载/更新需要。

## 模型体验

无。本包是纯 Host 侧商店网关，不注册任何 prompt、tool、消息或 provider 请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与后续工作

- **仅 registry 包名** — 安装/卸载/更新只接受裸 registry 包名，不接受版本范围、路径、git 或 tarball spec；版本选择遵循 pnpm 默认解析。
- **无在线发现** — 目录只通过内置索引或配置的 `indexUrl` 扩展，不提供 registry 搜索端点。
- **时点快照** — 清单不订阅 manifest 或 Loader 变化；客户端在变更完成后自行重新拉取。
