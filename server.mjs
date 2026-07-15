import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_FILE = path.join(__dirname, "了了_移动端低保真原型_V4.html");
const AGENT_FILE = path.join(__dirname, "了了_Agent_Markdown约束_V1.md");
const PORT = Number(process.env.PORT || 3000);
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").trim().toLowerCase();
const PROVIDERS = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    legacyKey: process.env.OPENAI_API_KEY
  },
  zenmux: {
    baseURL: "https://zenmux.ai/api/v1",
    defaultModel: "openai/gpt-5.6-terra",
    legacyKey: process.env.ZENMUX_API_KEY
  }
};
const provider = PROVIDERS[LLM_PROVIDER];
if (!provider) {
  throw new Error(`不支持的 LLM_PROVIDER：${LLM_PROVIDER}。可选值：openai、zenmux。`);
}
const LLM_API_KEY = process.env.LLM_API_KEY || provider.legacyKey || "";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || provider.baseURL).replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || process.env.OPENAI_MODEL || provider.defaultModel;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const H5_API_BASE_URL = process.env.H5_API_BASE_URL || "/api";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MAX_HISTORY_MESSAGES = 16;

if (!fs.existsSync(APP_FILE) || !fs.existsSync(AGENT_FILE)) {
  throw new Error("找不到 HTML 原型或 Agent Markdown 文件。");
}

const app = express();
const llm = LLM_API_KEY ? new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL }) : null;
const tasks = new Map();
const invitations = new Map();

app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && CORS_ORIGIN && (CORS_ORIGIN === "*" || origin === CORS_ORIGIN)) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN === "*" ? "*" : origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function readAgentMarkdown() {
  return fs.readFileSync(AGENT_FILE, "utf8");
}

function getSection(markdown, sectionNumber) {
  const matcher = new RegExp(`^## ${sectionNumber}\\..*?(?=^## \\d+\\.|(?![\\s\\S]))`, "ms");
  return markdown.match(matcher)?.[0] || "";
}

function buildScenePrompt(scene) {
  const sectionsByScene = {
    owner_chat: [1, 2, 3, 4, 11, 12],
    task_draft: [1, 2, 3, 5, 10, 11, 12],
    invitation: [1, 2, 3, 6, 11],
    target_h5_chat: [1, 2, 3, 7, 8, 11, 12],
    consent_extract: [1, 2, 3, 8, 10, 11, 12],
    report: [1, 2, 3, 9, 10, 11, 12]
  };

  const markdown = readAgentMarkdown();
  const shared = getSection(markdown, 0);
  const selected = (sectionsByScene[scene] || sectionsByScene.owner_chat)
    .map((number) => getSection(markdown, number))
    .filter(Boolean);

  return [shared, ...selected].join("\n\n");
}

function safeJsonParse(value, fallback) {
  if (typeof value !== "string") return fallback;

  try {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = (fenced || value).trim();
    return JSON.parse(candidate);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start === -1 || end <= start) return fallback;

    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return fallback;
    }
  }
}

function compactMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((message) => message && typeof message.content === "string")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content.slice(0, 2000)
    }));
}

function taskContext(task) {
  if (!task) return "当前尚未形成正式任务，仅根据用户这轮输入理解意图。";

  return [
    `任务 ID：${task.id}`,
    `任务名称：${task.title || "待命名"}`,
    `沟通对象称呼：${task.targetName || "对方"}`,
    `沟通目标：${task.goal || "待澄清"}`,
    `关系：${task.relationship || "待确认"}`,
    `隐私边界：${task.privacyBoundary || "只带回对方明确同意的信息"}`
  ].join("\n");
}

function publicTask(task) {
  return {
    task_id: task.id,
    title: task.title || "新的沟通任务",
    target_name: task.targetName || "对方",
    relationship: task.relationship || "待确认",
    goal: task.goal || "待澄清",
    privacy_boundary: task.privacyBoundary || "仅带回对方明确同意的信息。"
  };
}

function inferTargetName(content) {
  const explicitRelation = content.match(/(?:同事|朋友|伴侣|男友|女友|家人|客户|老师|同学|上级|下属)([\u4e00-\u9fa5]{2,3})(?=(?:帮|和|跟|与|想|说|聊|谈|沟通|澄清|一起|，|,|。|$))/);
  if (explicitRelation) return explicitRelation[1];

  const conversationTarget = content.match(/(?:和|跟|与|请|向)([\u4e00-\u9fa5]{2,4})(?=(?:吵|聊|谈|说|沟通|澄清|帮|一起|之间|，|,|。))/);
  return conversationTarget?.[1] || "";
}

function inferRelationship(content) {
  const patterns = [
    [/(?:邻居|邻里)/, "邻居"],
    [/(?:同事|项目|工作|团队)/, "同事"],
    [/(?:男友|女友|恋人|伴侣|对象)/, "恋人"],
    [/(?:朋友|闺蜜|兄弟)/, "朋友"],
    [/(?:父母|妈妈|爸爸|家人|孩子)/, "家人"],
    [/(?:客户|合作方)/, "合作关系"]
  ];
  return patterns.find(([pattern]) => pattern.test(content))?.[1] || "";
}

function isUsefulGoal(value) {
  return typeof value === "string"
    && value.trim().length >= 12
    && !/(了解用户|沟通事项|当前需求|待澄清)/.test(value);
}

function buildInvitationMessage(task) {
  const targetName = task.targetName || "你好";
  const relationship = task.relationship && task.relationship !== "待确认"
    ? `你的${task.relationship}`
    : "有人";
  const goal = task.goal || "这次沟通";

  return `${targetName}，你好。${relationship}邀请了“了了”作为中立沟通助手，想就“${goal}”听听你的想法。了了不会站队，也不会转述未获你确认的聊天内容；只有你最后明确勾选的信息才会被带回。愿意的话，可以点开链接随便聊几句。`;
}

async function generateText({ scene, task, messages, content, contract }) {
  if (!llm) {
    const error = new Error("未配置 LLM_API_KEY。请在 .env 中填入当前供应商的 API Key 后再使用真实模式。");
    error.status = 503;
    throw error;
  }

  const instructions = [
    buildScenePrompt(scene),
    "\n# 本次运行约束",
    `当前场景：${scene}`,
    taskContext(task),
    contract
  ].join("\n\n");

  const input = [
    ...compactMessages(messages),
    { role: "user", content: content || "请继续当前任务。" }
  ];

  const response = await llm.responses.create({
    model: MODEL,
    store: false,
    instructions,
    input
  });

  return response.output_text?.trim() || "我听到了。你愿意再多说一点吗？";
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

function getTaskByInvitation(token) {
  const invitation = invitations.get(token);
  const task = invitation ? getTask(invitation.taskId) : null;
  return task && invitation ? { task, invitation } : null;
}

function appendMessages(task, role, content, reply) {
  task.messages.push(
    { role, content, createdAt: new Date().toISOString() },
    { role: "assistant", content: reply, createdAt: new Date().toISOString() }
  );
}

app.get("/", (_req, res) => {
  res.sendFile(APP_FILE);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: LLM_PROVIDER,
    model: MODEL,
    model_ready: Boolean(llm),
    tasks: tasks.size
  });
});

app.post("/api/tasks", async (req, res, next) => {
  try {
    const { content, messages, mode } = req.body || {};
    if (!content?.trim()) return res.status(400).json({ message: "请输入沟通需求。" });

    const raw = await generateText({
      scene: "task_draft",
      content,
      messages,
      contract: `只输出 JSON：{ "message": "不超过80字的自然回复", "title": "任务名称", "target_name": "从用户输入中提取的沟通对象称呼；未知则写对方", "relationship": "关系", "goal": "沟通目标", "privacy_boundary": "隐私边界" }。不得臆造姓名。`
    });
    const draft = safeJsonParse(raw, {});
    const targetName = inferTargetName(content) || draft.target_name || "对方";
    const relationship = inferRelationship(content) || draft.relationship || "待确认";
    const goal = isUsefulGoal(draft.goal) ? draft.goal : content.trim();
    const task = {
      id: createId("task"),
      mode: mode || "自动判断",
      title: draft.title && draft.title.includes(targetName) ? draft.title : `与${targetName}的沟通任务`,
      targetName,
      goal,
      relationship,
      privacyBoundary: draft.privacy_boundary || "仅带回对方明确同意的信息。",
      messages: [],
      consentItems: [],
      report: null,
      createdAt: new Date().toISOString()
    };
    tasks.set(task.id, task);

    res.json({
      ok: true,
      scene: "task_draft",
      task_id: task.id,
      task: publicTask(task),
      message: { role: "assistant", content: draft.message || "我先为你整理了一份中立的沟通任务草稿。" },
      cards: [{
        type: "task_card",
        data: {
          title: task.title,
          target_name: task.targetName,
          relationship: task.relationship,
          goal: task.goal,
          privacy_boundary: task.privacyBoundary
        }
      }]
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/invitations", async (req, res, next) => {
  try {
    const task = getTask(req.params.taskId);
    if (!task) return res.status(404).json({ message: "沟通任务不存在。" });

    const token = crypto.randomBytes(18).toString("hex");
    const h5Link = `${PUBLIC_BASE_URL}/?mock=false&token=${token}&apiBaseUrl=${encodeURIComponent(H5_API_BASE_URL)}`;
    const invitation = { token, taskId: task.id, createdAt: new Date().toISOString() };
    const invitationMessage = buildInvitationMessage(task);
    invitations.set(token, invitation);

    res.json({
      ok: true,
      scene: "invitation",
      task_id: task.id,
      invitation_token: token,
      h5_link: h5Link,
      invitation_message: invitationMessage,
      task: publicTask(task),
      message: { role: "assistant", content: "邀请卡片已生成，你可以查看详情或复制链接发送给对方。" },
      cards: [{
        type: "invitation_card",
        data: {
          title: `给${task.targetName || "对方"}的邀请`,
          message: invitationMessage,
          h5_link: h5Link
        }
      }]
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/invitations/:token", (req, res) => {
  const result = getTaskByInvitation(req.params.token);
  if (!result) return res.status(404).json({ message: "邀请不存在或已失效。" });

  res.json({
    task_id: result.task.id,
    invitation_token: result.invitation.token,
    task: publicTask(result.task)
  });
});

app.get("/api/tasks/:taskId/updates", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ message: "沟通任务不存在。" });

  res.json({
    ok: true,
    task_id: task.id,
    task: publicTask(task),
    target_has_replied: task.messages.some((message) => message.role === "target"),
    consent_confirmed: Boolean(task.consentConfirmedAt),
    report: task.report || null
  });
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const { scene, role, task_id: taskId, invitation_token: token, content, messages } = req.body || {};
    if (!content?.trim()) return res.status(400).json({ message: "消息不能为空。" });

    const result = token ? getTaskByInvitation(token) : null;
    const task = result?.task || getTask(taskId);
    if (!task) return res.status(404).json({ message: "沟通任务不存在。" });

    const isTarget = role === "target" || scene === "target_h5_chat";
    const activeScene = isTarget ? "target_h5_chat" : "owner_chat";
    const raw = await generateText({
      scene: activeScene,
      task,
      content,
      messages,
      contract: isTarget
        ? `只输出 JSON：{ "message": "不超过80字的回复", "consent_items": ["可由对方自行勾选带回的事实，最多3条"] }。没有足够信息时 consent_items 返回空数组。`
        : `只输出 JSON：{ "message": "不超过80字的自然回复" }。`
    });
    const output = safeJsonParse(raw, {});
    const reply = output.message || "我听到了。你愿意再多说一点吗？";
    appendMessages(task, isTarget ? "target" : "owner", content.trim(), reply);

    const consentItems = isTarget && Array.isArray(output.consent_items)
      ? output.consent_items.filter((item) => typeof item === "string" && item.trim()).slice(0, 3)
      : [];
    if (consentItems.length) task.consentItems = consentItems;

    res.json({
      ok: true,
      scene: activeScene,
      task_id: task.id,
      task: publicTask(task),
      message: { role: "assistant", content: reply },
      cards: consentItems.length ? [{
        type: "consent_card",
        data: {
          title: "传话信息确认",
          intro: "只有你勾选确认的内容，才会被带回给对方。",
          items: consentItems.map((text, index) => ({ id: `consent_${index + 1}`, text, checked: true })),
          submit_text: "确认这版传回"
        }
      }] : []
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/invitations/:token/consent", async (req, res, next) => {
  try {
    const result = getTaskByInvitation(req.params.token);
    if (!result) return res.status(404).json({ message: "邀请不存在或已失效。" });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    result.task.consentItems = items
      .map((item) => typeof item === "string" ? item : item?.text)
      .filter((item) => typeof item === "string" && item.trim())
      .slice(0, 5);
    result.task.consentConfirmedAt = new Date().toISOString();

    const report = await createReport(result.task);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/report", async (req, res, next) => {
  try {
    const task = getTask(req.params.taskId);
    if (!task) return res.status(404).json({ message: "沟通任务不存在。" });
    res.json(await createReport(task));
  } catch (error) {
    next(error);
  }
});

async function createReport(task) {
  if (task.report) return task.report;
  const transcript = task.messages.map((message) => `${message.role}：${message.content}`).join("\n");
  const raw = await generateText({
    scene: "report",
    task,
    content: `已确认带回的信息：${task.consentItems.join("；") || "暂无"}\n\n对话记录：\n${transcript || "暂无"}`,
    messages: [],
    contract: `只输出 JSON：{ "message": "简短提示", "title": "理解报告标题", "confirmed_info": ["只写已确认的信息"], "neutral_summary": "中立理解", "suggested_expression": "给发起人的温和表达建议" }。`
  });
  const data = safeJsonParse(raw, {});
  task.report = {
    ok: true,
    scene: "report",
    task_id: task.id,
    message: { role: "assistant", content: data.message || "对方确认的信息已经整理成理解报告。" },
    profile: {
      ...publicTask(task),
      confirmed_info: task.consentItems,
      updated_at: task.consentConfirmedAt || new Date().toISOString()
    },
    cards: [{
      type: "report_card",
      data: {
        title: data.title || "沟通理解报告",
        confirmed_info: task.consentItems,
        neutral_summary: data.neutral_summary || "这次沟通仍有继续理解彼此感受的空间。",
        suggested_expression: data.suggested_expression || "谢谢你愿意说明。我们找个彼此舒服的时间，再慢慢聊。"
      }
    }]
  };
  return task.report;
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({
    message: error.status === 503 ? error.message : "AI 服务暂时无法回复，请稍后重试。"
  });
});

app.listen(PORT, () => {
  console.log(`了了 demo 已启动：http://localhost:${PORT}`);
});
