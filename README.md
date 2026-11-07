# Xiaomi MiMo For Copilot Chat

> **非官方社区扩展**：本项目由社区维护，与小米 / Xiaomi MiMo 官方无隶属关系。API 与定价以 [MiMo 开放平台](https://platform.xiaomimimo.com/) 为准。

在 **GitHub Copilot Chat** 中直接使用 [Xiaomi MiMo](https://mimo.mi.com/) 模型（Ask / Edit / Agent）。  
通过 VS Code `LanguageModelChatProvider` 接入，**无需自建聊天界面**。

## 功能

- **V2.6 全系模型**：Flash / Pro / Pro UltraSpeed（工具调用、图像输入、深度思考）
- **控制中心**：侧栏概览余额/额度、账单、Debug 请求、设置；点击状态栏即可打开/关闭
- **性能与费用**：状态栏显示 Tokens/s、Cache、首包时延、本轮费用（按量价目估算）
- **Debug**：最近请求列表（自动跟踪 `running`）、详情 Markdown、Output 通道日志
- **按量 / Token Plan**：支持 `sk-` 与 `tp-`/`ttp-`（Key 与 Base URL 须同属一套餐）

## 要求

- VS Code `^1.104`
- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)
- MiMo API Key（[开放平台控制台](https://platform.xiaomimimo.com/)）

## 快速开始

1. 安装本扩展（Marketplace 搜 `ALc51.xiaomi-mimo-for-copilot-chat`，或 `code --install-extension xiaomi-mimo-for-copilot-chat-*.vsix`）
2. 命令面板 → **Xiaomi MiMo: Manage API Key** → 保存 Key  
   （清除 Key 后模型列表会变空，属预期）
3. 打开 **语言模型**，在 **Xiaomi MiMo** 分组下勾选要用的模型
4. 在 Copilot Chat 模型选择器中选中 **Xiaomi MiMo** → 具体型号后发送消息

> 请选择分组 **Xiaomi MiMo**（本扩展），不要与 Copilot **Custom Endpoint** 里自建的「MiMo」条目混淆。

## 常用命令

| 命令 | 作用 |
|------|------|
| Xiaomi MiMo: Manage API Key | 保存 / 更换 API Key |
| Xiaomi MiMo: Clear API Key | 清除 Key（模型目录随之隐藏） |
| Xiaomi MiMo: Refresh Models | 刷新模型列表 |
| Xiaomi MiMo: Open Control Center | 打开控制中心 |

## 设置一览

| 设置 | 说明 | 默认 |
|------|------|------|
| `xiaomiMimo.baseUrl` | OpenAI 兼容 Base URL | `https://api.xiaomimimo.com/v1` |
| `xiaomiMimo.thinking` | `auto` / `enabled` / `disabled`；含 tools 或联网搜索时自动关思考 | `auto` |
| `xiaomiMimo.maxCompletionTokens` | 输出上限（含思考 token） | `131072` |
| `xiaomiMimo.webSearch` | 注入官方联网搜索（需控制台开通插件） | `false` |
| `xiaomiMimo.requestTimeoutMs` | 请求超时（毫秒） | `300000` |
| `xiaomiMimo.showPerfStatusBar` | 状态栏性能与费用 | `true` |
| `xiaomiMimo.estimateCurrency` | 按量费用币种：`auto` / `cny` / `usd` | `auto` |
| `xiaomiMimo.debugLogRequests` | Output 通道写请求摘要（不含 Key） | `false` |

**Token Plan**：把 `baseUrl` 改为控制台专属地址（如 `https://token-plan-cn.xiaomimimo.com/v1`），并使用对应 Key。**不可与按量 Key/URL 混用。**

## 用量说明

- Copilot 页脚 `0 credits` 对 BYOK 为正常现象；真实用量见会话信息与控制中心。
- 速度 / 缓存 / 费用在**状态栏**；点击图标切换左侧**控制中心**。
- 账单 Tab：按量可拉官网日用量；Token Plan 回退本地最近请求估算。

## 排障速查

| 现象 | 处理 |
|------|------|
| 语言模型里没有 Xiaomi MiMo 模型 | 先配置 API Key，再执行 Refresh Models / 重载窗口 |
| Chat 里选不到已勾选的模型 | 确认选的是厂商 **Xiaomi MiMo**，不是 Custom Endpoint「MiMo」 |
| 401 / 套餐报错 | 检查 Key 前缀与 Base URL 是否同为按量或 Token Plan |
| Agent 工具调用异常 | 保持 `thinking=auto`（有 tools 时会关思考，符合官方建议） |
| Output 里 Copilot `TaskApiError: 429` | 与 MiMo 无关，可忽略 |

## 开发

```bash
npm install
npm run compile
npm test
npm run package   # 生成 .vsix
```

## 参考

- [MiMo 首次调用 API](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [入站/出站对齐说明](docs/alignment.md)（仓库内）

## 许可

MIT
