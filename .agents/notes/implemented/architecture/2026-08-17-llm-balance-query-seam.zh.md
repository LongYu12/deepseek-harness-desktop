
# Agent Note：LLM 余额查询 seam 与会话头部余额胶囊

Status: implemented

[English](2026-08-17-llm-balance-query-seam.md) | 中文

## 问题

会话头部需要展示服务当前会话模型的 API 密钥的剩余额度。harness 此前没有提供方无关的账户余额查询途径：密钥存放在宿主的凭据 seam 之后，端点归各适配器所有，浏览器无法直接调用提供方端点。DeepSeek 平台在 chat completions 之外提供 `GET /user/balance`，而 harness 中没有任何组件会说这种语言。

## 决策

三条 seam，各自落在其权威已经存在的位置。

**`LlmRuntime` 上以 settings namespace 为键的余额 seam。** `registerBalanceQuery(settingsNs, query)` 仿照 `registerModelDiscovery`：namespace 点名查询将解析其端点与凭据的提供方，查询读取的是已存储配置，而非调用方提供的草稿。注册是一个 effect——每个 namespace 只能有一个提议（`INVALID_BALANCE_QUERY`/`DUPLICATE_BALANCE_QUERY`），并随调用 fiber dispose。`queryBalance(settingsNs, signal?)` 会校验每条返回条目并将其与提供方对象分离；未注册的 namespace 以 `NO_BALANCE_QUERY` 失败——没有注册本身就是消费方应呈现的「不支持」信号，绝不表示余额为空或为零。

**DeepSeek 适配器负责实现。** `dsh-llm-deepseek` 在自己的 `llm-deepseek` namespace 下注册查询，复用插件的每操作解析钩子，使余额请求与模型请求遵循同一套端点／密钥配对规则。`balance_infos` 条目映射为提供方无关的值；无密钥请求、非 200 响应和出乎意料的文档分别以凭据 seam 自身的 code 或 `BALANCE_UNAVAILABLE` 失败，绝不浮现语义不明的传输错误。

**一个受信 RPC 加一个浏览器占用者。** 网关新增 `llm.balance({ provider })`：先对照可配置提供方目录校验 provider，解析出拥有它的 settings namespace，再询问 `queryBalance`；路由缺失或未注册查询都以结构化 RPC 错误浮现，客户端将其读作「不支持」。由于响应会披露宿主存储密钥的账户财务信息，`llm.balance` 归入仅限受信宿主的方法集——匿名 LAN 调用者不可达。`@deepseek-ai/dsh-client-ui-balance-indicator` 以 order `-10` 注册一个 `conversation.session.header.utilities` 占用者，位于 `Session log` 按钮左侧：挂载时经 `session.models` 解析会话当前模型的提供方并拉取一次；点击则复用已知提供方重新拉取。失败与不支持状态渲染为 `--`。

## 考虑过的替代方案

**用 token 用量推算代替账户余额。** 否决：需求是密钥的剩余额度——账户级财务数据。用量推算回答的是另一个问题，且无法反映充值或其他消费。

**以提供方路由为键。** 否决：余额查询读取的是已存储配置，其所有权在 settings namespace；以路由为键会引入草稿与命名竞争。模型发现的先例已经基于同样的权威论证固定了 namespace 键控模式。

**浏览器直接询问提供方。** 否决：凭据绝不离开宿主，浏览器 fetch 会把密钥与页面点名的任意端点配对。

**定时轮询。** 否决：余额因外部充值而变化，不因轮次而变化。每次挂载拉取一次加点击刷新，使提供方流量有界且由手势驱动。

## 结果

未来的提供方只需在自己的 settings namespace 下注册一条查询即可增加余额支持——核心与 UI 都无需改动；胶囊和 RPC 把缺失的注册读作「不支持」，绝不读作零。`NO_BALANCE_QUERY` 与结构化 RPC 错误是承重的不支持信号；消费方不得把它们翻译成零值呈现。

仅限受信宿主的归类是承重的：`llm.balance` 回答的是宿主密钥的账户财务信息，因此 carrier 必须让它与 `credentials.describe` 一样处于匿名不可达的范围。组合在不受信 carrier 上的界面必须把该方法视为不可用。

胶囊只展示第一个币种条目并保留两位小数，且从不轮询；多币种呈现与定时刷新暂缓到出现需要的消费方为止。
