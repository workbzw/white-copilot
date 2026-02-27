import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * 大模型调用：支持内部 OpenAI 兼容 API（通过 baseURL / model / apiKey 配置），
 * 未配置时回退到硅基流动默认地址。
 */

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3.2";

function getBaseUrl(): string {
  return process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function getModel(): string {
  return process.env.LLM_MODEL?.trim() || process.env.SILICONFLOW_MODEL?.trim() || DEFAULT_MODEL;
}

function getApiKey(): string {
  const key = process.env.LLM_API_KEY?.trim() || process.env.SILICONFLOW_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "未配置大模型 API Key，请在 .env 中设置 LLM_API_KEY（或 SILICONFLOW_API_KEY）"
    );
  }
  return key;
}

/**
 * 获取 Chat 模型实例（OpenAI 兼容接口）。
 * 通过环境变量配置内部大模型：LLM_BASE_URL、LLM_MODEL、LLM_API_KEY。
 */
export function getSiliconFlowChatModel(options?: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) {
  const model = options?.model?.trim() || getModel();
  const apiKey = getApiKey();
  const baseURL = getBaseUrl();
  return new ChatOpenAI({
    model,
    apiKey,
    configuration: {
      baseURL,
      apiKey,
    },
    temperature: options?.temperature ?? 0.7,
    maxTokens: options?.maxTokens ?? 4096,
  });
}

/**
 * 调用硅基流动生成报告大纲。
 * 返回有序的大纲条目数组。
 */
export async function generateReportOutline(params: {
  topic: string;
  coreContent?: string;
  styleMode: "ai" | "standard";
  referenceText?: string;
}): Promise<string[]> {
  const llm = getSiliconFlowChatModel({ temperature: 0.5, maxTokens: 2048 });

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

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ];

  const response = await llm.invoke(messages);
  const text =
    typeof response.content === "string"
      ? response.content
      : String(response.content ?? "");

  console.log("[SiliconFlow] 模型原始输出:\n", text);
  const outline = parseOutlineText(text);
  console.log("[SiliconFlow] 解析后大纲条数:", outline.length);
  return outline;
}

/**
 * 从模型输出文本解析为大纲条目数组（保留原文，仅按行分割并去空）。
 */
function parseOutlineText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
