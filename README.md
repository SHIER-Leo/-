# 了了 Demo

## 本地运行

1. 在 `.env` 中设置 `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`。
2. 执行 `npm.cmd install`（PowerShell 提示脚本被禁用时使用该命令）。
3. 执行 `npm.cmd run dev`。
4. 打开 `http://localhost:3000/?mock=false`。

默认仍可直接打开 HTML 或访问 `?mock=true` 使用本地模拟数据；真实模式会读取 `了了_Agent_Markdown约束_V1.md`，并由 `server.mjs` 调用模型。

默认配置为 ZenMux：`LLM_PROVIDER=zenmux`、`LLM_BASE_URL=https://zenmux.ai/api/v1`、`LLM_MODEL=openai/gpt-5.6-terra`。切回 OpenAI 时，将供应商改为 `openai`、地址改为 `https://api.openai.com/v1`，并填入 OpenAI 的 Key 和模型名。

若 H5 和 API 部署在不同域名，设置 `.env` 的 `CORS_ORIGIN` 为 H5 的完整来源，例如 `https://demo.example.com`；并在 H5 URL 中传入 `apiBaseUrl=https://api.example.com/api`。

## 接口

- `POST /api/tasks`
- `POST /api/tasks/:taskId/invitations`
- `GET /api/invitations/:token`
- `POST /api/chat`
- `POST /api/invitations/:token/consent`
- `GET /api/tasks/:taskId/report`

数据仅存在内存中，重启服务会清空，适合 demo 和内部测试。
