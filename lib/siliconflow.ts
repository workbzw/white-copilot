/**
 * 大模型调用：使用 Axios 调用 OpenAI 兼容 API，避免 Node fetch 的 ByteString 中文问题。
 * 环境变量：LLM_BASE_URL、LLM_MODEL、LLM_API_KEY。
 */

import {
  chatCompletion as llmChatCompletion,
  streamChatCompletion,
  type ChatMessage,
} from "@/lib/llm-axios";

/** 非流式对话（供 polish、outline 等使用） */
export async function chatCompletion(params: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  return llmChatCompletion({
    ...params,
    model: params.model || getModel(),
  });
}

const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";

function getModel(): string {
  return process.env.LLM_MODEL?.trim() || process.env.SILICONFLOW_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * 调用硅基流动生成报告大纲。
 */
export async function generateReportOutline(params: {
  topic: string;
  coreContent?: string;
  styleMode: "ai" | "standard";
  referenceText?: string;
}): Promise<string[]> {
  const styleHint =
    params.styleMode === "standard"
      ? "请按标准公文结构：报告摘要、背景与依据、现状与数据、问题分析、对策建议、结论与下一步工作等。"
      : "可自由组织章节，突出专业分析与建议。";

  const systemPrompt = `你是一名专业报告撰写助手。根据用户给出的报告主题和补充信息，生成一份简洁的报告中纲（仅一级标题）。
${styleHint}
要求：
1. 只输出大纲条目，每行一条，使用中文序号（一、二、三…）或数字序号均可。
2. 不要输出前言、解释或其它说明，仅输出大纲。
3. 若用户提供了重点引用资料，必须依据资料中的结构与要点来组织大纲，使后续正文能直接引用资料内容。`;

  const userParts = [
    `报告主题：${params.topic}`,
    params.coreContent ? `核心内容/背景补充：\n${params.coreContent}` : "",
    params.referenceText
      ? `【重点引用资料（请依据以下内容组织大纲，正文将据此引用）】\n\n${params.referenceText}`
      : "",
  ].filter(Boolean);
  const userContent = userParts.join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const text = await llmChatCompletion({
    messages,
    model: getModel(),
    temperature: 0.5,
    maxTokens: 2048,
  });

  console.log("[SiliconFlow] 模型原始输出:\n", text);
  const outline = parseOutlineText(text);
  console.log("[SiliconFlow] 解析后大纲条数:", outline.length);
  return outline;
}

function parseOutlineText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 流式生成正文：返回异步迭代器，每次 yield 一段文本。
 * 供 /api/body 与 /api/body-section 使用。
 */
export async function* streamChat(params: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): AsyncGenerator<string, void, unknown> {
  yield* streamChatCompletion({
    messages: params.messages,
    model: params.model || getModel(),
    temperature: params.temperature ?? 0.6,
    maxTokens: params.maxTokens ?? 4096,
  });
}
