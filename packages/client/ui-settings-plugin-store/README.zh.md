# @deepseek-ai/dsh-client-ui-settings-plugin-store

[English](README.md) | 中文

Web 设置的**插件商店** tab。浏览器插件注册两个本地化的 `settings.plugins.tab` 贡献：id 为 `store`、order 为 20，id 为 `import`、order 为 30，另加一个 `settings.action` 贡献（`plugin-store-hot-reload`，order 10）在头部渲染热重载按钮，调用 `hotReload` 并用 status 展示结论；Plugins 分区拥有导航条目与 tab 外框。插件激活期间不进行任何 Remote 读取。首次挂载商店 tab 时才通过 [`api-remotes`](../../api/remotes/README.md) 惰性调用 `ctx.remote.pluginStore.catalog()` 与 `ctx.remote.pluginStore.inventory()`。

商店 tab 先渲染一个带商店配置快捷入口的工具栏，再分两段。快捷按钮调用 `openStoreConfig`，物化 profile 用户补丁层并用文本编辑器打开；结果通知直接展示 Host 返回的含文件路径的消息。商店区对目录做本地过滤（名称、描述、作者与 tags 参与匹配），卡片展示随语言切换的描述、作者与 tags，并带一个安装按钮：Remote 变更进行中显示"安装中"，刷新后的清单包含该包后变为"已安装"标签。已安装区列出 profile bundle 及其版本，提供更新与卸载操作，只要与启动快照有差异就显示重启提示；其下为已加载的 Loader 条目展示状态标签（已启用/已停用）与启停开关，调用 `setEntryEnabled`，经 store 补丁层热生效——被其他配置层停用的条目开关会被锁定并附说明提示。加载、空态、无匹配与失败态都留在已挂载组件内部；目录与清单失败可各自重试，变更返回失败时展示 Host 消息，传输拒绝时展示通用文案。导入 tab 收集一条导入命令（`dsh plugin [--profile <name>] add <spec>`）或裸 spec 并提交给 `importBundle`；变更进行中通过转发的 `plugin-store/progress` 事件流式展示解析出的目标与最新的 pnpm stderr 行，结果通知展示 Host 消息，导入加入 bundle 层时附带重启提示，成功导入还会通知商店 tab 重新拉取已安装列表。被拒绝的命令（错误 profile）或非法 spec 展示 Host 的拒绝信息。注册使用 `ctx.slots.inject()`，因此能跟随 tab 的延迟声明、重新声明、语言切换与拆除，无需导入分区属主。

## 模型体验

无。本包只在浏览器设置中驱动 Host 插件商店 Remote，不注册任何模型可见面。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与后续工作

- **快照而非订阅** — 各 tab 不订阅商店变化；成功的变更会重新拉取清单，成功的条目启停还会在补丁层 HMR 重组落定后再拉取一次，成功的导入会通知商店 tab 重新拉取，外部无关变化在下次挂载时才可见。
- **无版本选择** — 安装、更新与导入遵循 pnpm 默认解析；界面展示解析出的版本，但不能锁定版本。
