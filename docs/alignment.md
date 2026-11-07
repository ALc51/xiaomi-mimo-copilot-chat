# 入站 / 出站对齐清单

对照：`chat-model-provider-sample`、`vscode.d.ts` LM API、`vscode-copilot-chat` 的 `extChatEndpoint.ts` / `languageModelAccess.ts` / `endpointTypes.ts`、MiMo OpenAI Chat Completions。

## 注册

| 项 | 值 |
|----|-----|
| vendor | `xiaomi-mimo` |
| API | `vscode.lm.registerLanguageModelChatProvider` |
| engines | `vscode ^1.104` |
| capabilities | `toolCalling: true`, `imageInput: true`（Agent 必需） |

## 入站（Copilot → 扩展）

| Copilot part | MiMo messages |
|--------------|---------------|
| System / User / Assistant + `LanguageModelTextPart` | `role` + `content` 文本（或多 part 数组） |
| `LanguageModelToolCallPart` | assistant `tool_calls[]`（function name/arguments/id） |
| `LanguageModelToolResultPart` | `role: tool` + `tool_call_id` + content |
| 图片 `LanguageModelDataPart`（image mime） | `image_url.url` = `data:{mime};base64,...` |
| `LanguageModelThinkingPart` | assistant 顶层 `reasoning_content`（全量历史回传） |
| `options.tools` | OpenAI `tools[].type=function` |
| `options.toolMode` | MiMo 仅支持 `tool_choice=auto`（非 auto 会被服务端丢弃） |

## 出站（扩展 → Copilot）

| MiMo SSE | progress.report |
|----------|-----------------|
| `delta.content` | `LanguageModelTextPart` |
| `delta.tool_calls`（按 index 合并） | `LanguageModelToolCallPart` |
| `delta.reasoning_content` | `LanguageModelThinkingPart`（带稳定 id；宿主未实现则跳过） |
| 末包 `usage` | `LanguageModelDataPart`：JSON snake_case；mime `usage` |
| `finish_reason` length / content_filter / repetition… | Output 日志 + 追加一条用户可见警告文本 |

## Token 计数

- `provideTokenCount(string | LanguageModelChatRequestMessage)`：按 part 累加，禁止整对象 `toString()`。
- 支撑会话信息分项（系统提示 / 工具定义 / 工具结果 / 消息）由 Copilot 归类。

## Thinking × Tools（官方 FAQ）

- 凡本轮 `tools` 非空（含 Copilot function tools 与注入的 `web_search`）→ `thinking.type=disabled`。
- `thinking=enabled` 在有 tools 时也会被强制 disabled，并写 Output 说明。
- 无 tools 时：`auto`/`enabled` → `enabled`，并固定 temperature/top_p = 1.0 / 0.95。
- 带 `tool_calls` 的历史 assistant 必须回传 `reasoning_content`；宿主丢 ThinkingPart 时靠会话缓存兜底。

## 模型目录与鉴权

- **无 API Key** → `provideLanguageModelChatInformation` 返回 **空列表**（清除 Key 后不应再显示 Flash/Pro 目录）。
- **Key 与 Base URL 套餐不一致**（sk- ↔ Token Plan URL）→ 列表为空；聊天请求直接抛错，不发到 API。
- silent 模式不弹窗要 Key（符合 VS Code LM Provider 指南）。

## 已知上游缺口

- VS Code 公开 LM Provider 指南的 Response parts **未列 ThinkingPart**；跨轮是否带回取决于 Copilot，扩展只能尽力回传 + 缓存。
- 无法在会话信息圆圈旁插入自定义 UI；perf 走 `chatStatusItem`（proposed）或 Status Bar。
