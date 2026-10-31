# 拾燕模型提供方（Provider）架构

拾燕对话里的「模型选择」由服务端统一管理。每接入一种 SDK，就在本目录新增一个 provider 模块，并在 `index.mjs` 注册。`server.mjs` 只调用这里的统一接口，不直接依赖任何 SDK。

| provider | 模块 | SDK | 认证 |
|---|---|---|---|
| `openai`（GPT） | `codex.mjs` | `@openai/codex-sdk` | `~/.codex/auth.json` |
| `anthropic`（Claude） | `claude.mjs` | `@anthropic-ai/claude-agent-sdk` | 见下文 |

## 数据流

1. `GET /v1/capabilities`：`registry.refreshCatalog()` 汇总所有可用 provider 的模型（5 分钟缓存），每个模型带有 `provider`、`providerLabel` 和 `features` 字段。三端客户端按 `provider` 把选择器分组。
2. `POST /v1/jobs`：按 `model` 找到对应的 provider，并记录在 `job.provider` 上。
3. `runJob`：
   - 管理员（服务器权限）：调用 `provider.runTurn(ctx)`，返回统一事件流，由 server.mjs 中原有的事件循环处理；
   - 普通账号：调用 `provider.runIsolatedJob(job, opts)`，工具一律在 bwrap 隔离沙箱中执行。
4. 会话：每个 provider 的上下文 ID 单独保存在 `conv.sessions[providerId]` 中（`openai` 为兼容旧数据，继续使用 `conv.threadId`）。切换到另一个 provider 时，新开一个会话，并把最近的对话记录作为上下文带过去。

## Provider 合同

```js
export default {
  id: 'example',             // 小写字母开头，全局唯一
  label: 'Example',          // 选择器分组名
  sdk: 'example-sdk',        // 仅用于状态展示
  features: { images, files, imageGeneration },
  available(): boolean | Promise<boolean>,   // 例如是否已配置认证；false 时不出现在目录中
  listModels(): Promise<Array<{ id, displayName, reasoningEfforts: string[], defaultReasoning }>>,
  runTurn(ctx): Promise<{ events: AsyncIterable<ThreadEvent> }>,
  runIsolatedJob(job, { history, memory, signal, onEvent, onText, onActivity, root }):
    Promise<{ text, usage, threadId, displayItems, fileChanges, artifacts }>,
};
```

`runTurn(ctx)` 的参数：`{ model, reasoning, cwd, resume, input, mcpServers, signal }`

- `input`：Codex UserInput，即字符串，或 `{type:'text',text}`、`{type:'local_image',path}` 组成的数组。
- `mcpServers`：`{ name: { command, args, env, secretEnv, timeoutSec } }`。`secretEnv` 只能通过子进程环境传入，不得写进命令行或模型上下文。
- `resume`：该 provider 上一轮返回的会话 ID，没有则为 `null`。

统一事件（与 `@openai/codex-sdk` 的 ThreadEvent 同构，参考 `claude-events.mjs`）：

- `thread.started {thread_id}`：会话 ID，用于下一轮 `resume`
- `item.started` / `item.updated` / `item.completed {item}`：item 类型包括 `agent_message`、`reasoning`、`command_execution`、`mcp_tool_call`、`file_change`、`todo_list`、`web_search`
- `turn.completed {usage:{input_tokens,cached_input_tokens,output_tokens}}` 或 `turn.failed {error:{message}}`

只要 provider 输出这套事件，展示、同步、产物收集、文件变更以及三端客户端都不用改。

## 纯推理接口 `infer`（可选，供模型中枢使用）

RAG、Dots 的推理类调用、BOSS 判别等只做“输入 -> 文本/JSON”，不需要线程和工具。想让这类调用也能选到新的 SDK，就给 provider 加 `infer`：

```js
async infer({ model, reasoning, prompt, images, schema, history, resume, system, webSearch, signal })
  // -> { text, usage, threadId }
```

- `images`：`[{data: base64, suffix}]`；`schema`：JSON Schema，`text` 必须是符合它的 JSON 字符串。
- 原生支持 schema 的（Codex）直接传；不完整支持的（Claude）用 `json-output.mjs`：写进提示词、提取 JSON、用 ajv 校验、不通过时带着错误重试一次。
- `history` 是中枢保存的最近几轮文本，`resume` 是上一轮返回的会话 ID，各取所需即可。
- `webSearch=true` 只在调用方明确依赖联网核验时出现，其余情况必须无工具、无网络。
- 没有 `infer` 的 provider 不会出现在中枢的可选项里。具体用法见 `~/model-hub/README.md`。

## Claude 认证

认证方式写进服务器 `~/.config/shiyan/claude.env`（权限 600）或直接登录，约 5 分钟内生效，也可以在页面点“刷新模型目录”。认证前页面里 Claude 显示“暂不可用”，不能选。

- 订阅账号，在 Mac 上取令牌：Mac 终端运行 `claude setup-token`（需要订阅），把得到的长期令牌写成 `CLAUDE_CODE_OAUTH_TOKEN=…`。服务器上不用开浏览器。
- 订阅账号，在服务器上直接登录：运行 `~/boss-codex-service/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude auth login`，按提示在浏览器里登录。凭据存到 `~/.claude/.credentials.json`，页面会自动识别。
- API Key：写成 `ANTHROPIC_API_KEY=…`。

关于订阅账号：Agent SDK 文档写明，除非事先获得批准，第三方开发者不得在自己的产品中提供 claude.ai 登录或其速率限制。限制的是把订阅登录或额度提供给他人使用。拾燕里 RAG、Dots 都有其他成员账户，他们的请求同样会经过中枢，这类用量要不要走订阅账号，请自己判断；需要时可以改用 API Key。另外，RAG 的 PDF 识别和 Dots 的主动感知会持续产生调用，订阅账号的额度可能消耗得比较快。

中枢里的同一套说明见 `~/model-hub/README.md`。设置 `SHIYAN_CLAUDE_DISABLED=1` 可以临时关闭 Claude。
