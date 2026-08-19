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

**capability seam 的 Host 服务。** `@deepseek-ai/dsh-host-plugin-store` 注册 `pluginStore` 服务，发布八个生成的 direct Remote：`catalog`、`inventory`、`installBundle`、`importBundle`、`removeBundle`、`updateBundle`、`setEntryEnabled`、`openStoreConfig`。变更动词带 `Bundle` 后缀，因为 Client 网关会拒绝任何与命名空间服务成员同名的 Remote 方法，而裸 `install` 与 `remove` 正是保留词；未来任何商店类服务都必须继续避开这两个动词。目录随包发布三个官方 bundle 的内置索引；设置 `indexUrl` Config 后用 AbortSignal 超时拉取同 schema JSON，任何远程失败都直接报错而非静默回退。变更操作在 profile 目录（Loader `baseUrl`；缺失时所有变更方法 fail loud，因此非 profile 启动无法变更任何东西）内 spawn pnpm，随后经共享协调器写回 bundle 层。`installBundle`/`removeBundle`/`updateBundle` 只接受裸 registry 包名——路径与 tarball spec 在 spawn 前就被拒绝；`importBundle` 只接受 git spec（GitHub 简写 `owner/repo` 或 `github:owner/repo`，以及以 `.git` 结尾的 `git+https:`/`git+ssh:`/`git:`/`https:` URL，均可带可选 `#ref` 后缀），由排除一切 shell 元字符的白名单正则校验，spec 永远无法逃出 pnpm 参数。`inventory` 把实时 manifest 与 Loader 条目对照启动快照报告 `restartNeeded`，并对条目启用状态做投影：上报状态在写入返回时即叠加 store 层的停用标记，先于补丁层在 Loader 上的 HMR 重组——因为写入成功时重组尚未完成，立即回读的调用方否则会看到陈旧的 Loader 状态。`openStoreConfig` 物化 profile 的用户补丁层 `cordis.patch.yml`（缺失时写入空行表种子，从不改动已有内容）并交给文本编辑器——它是 `indexUrl` 等 store 可调项的快捷入口，在其中添加 `{ id: plugin-store, config: { ... } }` 行即可覆盖。

**设置 tab，而非新表层。** `@deepseek-ai/dsh-client-ui-settings-plugin-store` 通过 `ctx.slots.inject()` 注册两个 `settings.plugins.tab` 贡献：id `store`（order 20）与 id `import`（order 30），后者是粘贴 git spec 的输入框，调用 `importBundle` 经 pnpm add 安装。两者激活期间都不做任何读取；挂载 tab 时才惰性调用各自的 Remote。工具栏按钮调用 `openStoreConfig` 作为配置快捷入口。商店 tab 把搜索框与过滤后的目录卡片排在已安装区之上，已安装卡片在标签旁直接给出卸载按钮，移除动作就在搜索结果处完成。已安装区列出 bundle 及更新/卸载操作，与启动快照有差异时显示重启提示，并为已加载的 Loader 条目在调用 `setEntryEnabled` 的开关旁展示状态标签（已启用/已停用）——标签报告状态、按钮表达动作；被 store 之外的配置层停用的条目开关会被锁定，因为启用只会撤销 store 自己的标记。成功的启停之后 tab 立即重拉一次，并在 HMR 重组落定后再拉一次。`api-remotes` 与现有 Remote 并列挂载 `pluginStoreRemote`。

## Alternatives considered

**改写用户的 `cordis.patch.yml` 实现启停。** 拒绝：把该文件序列化回 YAML 会丢注释和 `!!js` 标签，破坏用户内容。store 专属的伴生文件完全绕开往返，且用户层在其之上保有权威。

**安装/卸载/更新热生效。** 当时拒绝：bundle 层列表在启动时读取一次，组合树据此构建；要实时生效需在中途重建 Loader 树。在 UI 中显式呈现 `restartNeeded` 标志诚实且便宜得多。已被[热重组](2026-08-18-plugin-store-live-recomposition.md)取代：Include 更新路径把完整补丁栈重放进运行中的树，注册了 composer 时 bundle 层变更无需重启即生效。

**以 npm registry 在线搜索作为目录。** 拒绝：发现渠道保持策展——内置索引加可选远程索引 URL——变更也只接受 registry 名。registry 搜索会在没有策展点的情况下同时放宽发现面与安装面。

**远程索引损坏时静默回退到内置目录。** 拒绝：配置错误的 `indexUrl` 应作为可重试的错误呈现给操作者，而不是用一份与预期不同的目录掩盖自己。

**协调逻辑留在 CLI。** 拒绝：`dsh.profile.bundles` 的第二个写入者会复制层列表规则并漂移；提取纯核心的代价只是一个导入边界。

## Consequences

浏览、安装、卸载、更新与启停插件现在完全在 Web 设置 UI 内完成，无需 CLI 往返。启停经 watcher 热生效；安装/卸载/更新在注册了 composer 处经[热重组](2026-08-18-plugin-store-live-recomposition.md)生效，否则报告重启并在 UI 中说明失败原因。

层顺序契约是承重墙：store 补丁组合在用户层之前，因此用户补丁可覆盖 store 开关——这是有意为之，因为用户文件是最顶层权威。store 不改动 `cordis.patch.yml` 的内容；`cordis.store.patch.yml` 是它唯一的写入目标，`openStoreConfig` 只在文件缺失时写入种子再交给编辑器。文本编辑器意图在 Windows 上直接启动记事本（`dsh-native-command`）：`.yml` 文件通常没有文件关联，shell 打开会返回成功，而系统选择器开在应用窗口之后。

仅 registry 包名的安装规则收窄了攻击面，也收窄了能力：无法锁定版本，商店不提供本地路径或 tarball 安装（CLI 路径仍接受 pnpm 所接受的一切）；git 安装经专用导入 tab 及其 spec 白名单路由。`indexUrl` 失败与缺失 `baseUrl` 的启动按设计 fail loud，因此调用方把这些翻译为 UI 错误态，而非静默重试。
