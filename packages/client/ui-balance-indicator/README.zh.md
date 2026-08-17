# @deepseek-ai/dsh-client-ui-balance-indicator

[English](README.md) | 中文

Web 会话头部余额胶囊。宿主侧为 no-op；浏览器侧拥有一个 `conversation.session.header.utilities` 占用者，展示会话当前模型所属提供方存储密钥的剩余额度。余额询问本身属于 [dsh-llm](../../llm/llm/README.md) 的 `registerBalanceQuery`/`queryBalance` seam，经 `dsh-host-apiproxy` 的 `llm.balance` 暴露；本包只负责解析、呈现与刷新。

## 行为

挂载时，胶囊先经 `session.models` 解析会话当前模型的提供方，再经 `llm.balance` 查询该提供方的账户余额。点击胶囊会复用已解析的提供方重新拉取余额。同一会话的并发点击共享一次进行中的操作；插件卸载会中止进行中的查询，迟到的结算不再发布任何状态。

胶囊呈现三种状态：加载中显示 `…`；查询返回余额时展示可用额度——取第一个币种条目，按币种代码选取符号，金额保留两位小数，例如 `余额 ¥12.34`；失败、空报告或未注册余额查询的提供方显示 `--`。`--` 是明确的不支持呈现——缺失绝不会被渲染为零。

余额是宿主存储密钥的账户级财务数据，不是每会话的 token 用量：共享同一密钥的所有会话显示相同数字。胶囊在挂载时拉取一次，不做轮询。

## 组合

```yaml
- id: ui-balance-indicator
  name: '@deepseek-ai/dsh-client-ui-balance-indicator'
```

Web bundle 将该包挂载在 `dsh-client-ui-conversation` 旁。占用者以 order `-10` 注册，因此在右对齐的 utilities 列表中渲染在默认 order 的 `Session log` 按钮左侧。`llm.balance` 是仅限受信宿主的 RPC 方法：响应会披露宿主存储密钥的账户财务信息，匿名 LAN 调用者不可达。

## 模型体验

### 余额胶囊

#### 模型所见

无。`session.models` 提供方解析与 `llm.balance` 余额询问都不进入模型历史。

#### Token 影响

零。胶囊不产生任何模型轮次。

#### KV Cache 影响

无。宿主侧读取不改变派生的请求前缀。

## 已知限制与暂缓事项

- **只有 DeepSeek 注册了余额查询**——`dsh-llm-deepseek` 实现了 `/user/balance`；其他提供方上的会话显示 `--`，直到其适配器注册查询。
- **只展示第一个币种条目**——报告多个币种的提供方需要更丰富的呈现。
- **不做定时刷新**——余额只在挂载与点击时更新；外部充值要在下一次手势后才可见。
