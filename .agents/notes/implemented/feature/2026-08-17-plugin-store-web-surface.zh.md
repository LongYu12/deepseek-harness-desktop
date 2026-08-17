# Agent Note：插件商店 Web 表层与 store 专属补丁层

Status: implemented

[English](2026-08-17-plugin-store-web-surface.md) | 中文

## Problem

插件是声明 `dsh.bundle` 的 npm 包，由 `dsh plugin` 转发 pnpm 装入 profile，并协调进 manifest 的 `dsh.profile.bundles` 层列表。Web 设置表层此前只能展示只读清单：无法从浏览器浏览目录、安装或卸载 bundle，也无法启停已安装的插件。

两个结构性缺口挡住了正确实现。其一，bundle 组合在进程启动时即固定——`loadProfile` 对层栈做一次快照——因此安装/卸载/更新不重启 dsh 无法生效，而启停只需要一个配置补丁，理应热生效。其二，唯一的补丁机制是改写用户的 `cordis.patch.yml`，往返 YAML 序列化会丢注释和 `!!js` 标签，永远不能成为机器写入开关的地基。CLI 还私有 bundle 协调逻辑，第二个写入者必然与之漂移。

## Decision

四道接缝，各自由权威已在的位置持有。

**store 专属补丁层。** `dsh-app-boot` 的 `Profile` 新增 `storePatchPath`/`storePatches`，对应 profile 目录内的新文件 `cordis.store.patch.yml`，组合位置在 bundle 层之后、用户层之前，使用户补丁保有最终决定权。该文件由 store 独占——没有别的写入者——按需出现而非 `initProfile` 时创建。`profile-boot` 在两条组合路径中都纳入该层并为其追加 watcher，因此开关变更走与 `cordis.patch.yml` 相同的 HMR 重组：启停热生效、无需重启。

**共享 bundle 协调。** CLI 插件协调的纯核心被提取为 `dsh-app-boot` 导出的 `reconcileBundles(manifest, isBundle)`。CLI 保留其 stderr 警告包装；store 直接调用共享核心，两个写入者在层列表语义上不会漂移。

**capability seam 的 Host 服务。** `@deepseek-ai/dsh-host-plugin-store` 注册 `pluginStore` 服务，发布六个生成的 direct Remote：`catalog`、`inventory`、`installBundle`、`removeBundle`、`updateBundle`、`setEntryEnabled`。变更动词带 `Bundle` 后缀，因为 Client 网关会拒绝任何与命名空间服务成员同名的 Remote 方法，而裸 `install` 与 `remove` 正是保留词；未来任何商店类服务都必须继续避开这两个动词。目录随包发布三个官方 bundle 的内置索引；设置 `indexUrl` Config 后用 AbortSignal 超时拉取同 schema JSON，任何远程失败都直接报错而非静默回退。变更操作在 profile 目录（Loader `baseUrl`；缺失时所有变更方法 fail loud，因此非 profile 启动无法变更任何东西）内 spawn pnpm，随后经共享协调器写回 bundle 层。`installBundle`/`removeBundle`/`updateBundle` 只接受裸 registry 包名——路径、git 与 tarball spec 在 spawn 前就被拒绝。`inventory` 把实时 manifest 与 Loader 条目对照启动快照，报告 `restartNeeded`。

**设置 tab，而非新表层。** `@deepseek-ai/dsh-client-ui-settings-plugin-store` 通过 `ctx.slots.inject()` 注册一个 `settings.plugins.tab` 贡献（id `store`，order 20）。激活期间不做任何读取；挂载 tab 时才惰性调用 `catalog()` 与 `inventory()`。商店区对目录做本地过滤；已安装区列出 bundle 及更新/卸载操作，与启动快照有差异时显示重启提示，并为已加载的 Loader 条目提供调用 `setEntryEnabled` 的开关。`api-remotes` 与现有 Remote 并列挂载 `pluginStoreRemote`。

## Alternatives considered

**改写用户的 `cordis.patch.yml` 实现启停。** 拒绝：把该文件序列化回 YAML 会丢注释和 `!!js` 标签，破坏用户内容。store 专属的伴生文件完全绕开往返，且用户层在其之上保有权威。

**安装/卸载/更新热生效。** 拒绝：bundle 层列表在启动时读取一次，组合树据此构建；要实时生效需在中途重建 Loader 树。在 UI 中显式呈现 `restartNeeded` 标志诚实且便宜得多。

**以 npm registry 在线搜索作为目录。** 拒绝：发现渠道保持策展——内置索引加可选远程索引 URL——变更也只接受 registry 名。registry 搜索会在没有策展点的情况下同时放宽发现面与安装面。

**远程索引损坏时静默回退到内置目录。** 拒绝：配置错误的 `indexUrl` 应作为可重试的错误呈现给操作者，而不是用一份与预期不同的目录掩盖自己。

**协调逻辑留在 CLI。** 拒绝：`dsh.profile.bundles` 的第二个写入者会复制层列表规则并漂移；提取纯核心的代价只是一个导入边界。

## Consequences

浏览、安装、卸载、更新与启停插件现在完全在 Web 设置 UI 内完成，无需 CLI 往返。启停经 watcher 热生效；安装/卸载/更新报告并要求重启进程，UI 明确说明。

层顺序契约是承重墙：store 补丁组合在用户层之前，因此用户补丁可覆盖 store 开关——这是有意为之，因为用户文件是最顶层权威。store 永远不应手改 `cordis.patch.yml`；`cordis.store.patch.yml` 是它唯一的写入目标。

仅 registry 包名的安装规则收窄了攻击面，也收窄了能力：无法锁定版本，商店不提供本地路径或 git 安装（CLI 路径仍接受 pnpm 所接受的一切）。`indexUrl` 失败与缺失 `baseUrl` 的启动按设计 fail loud，因此调用方把这些翻译为 UI 错误态，而非静默重试。
