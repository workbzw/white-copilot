import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

/**
 * 硅基流动 API 与 OpenAI 兼容，使用 LangChain ChatOpenAI 并指定 baseURL。
 * 文档: https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
 */

const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";

function getApiKey(): string {
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      "未配置 SILICONFLOW_API_KEY，请在 .env 或环境变量中填写硅基流动 API Key"
    );
  }
  return key.trim();
}

/**
 * 获取硅基流动的 Chat 模型实例，用于 Agent / 对话补全。
 * 模型名见: https://cloud.siliconflow.cn/sft-d29cs9gh3vvc73c59kb0/models?types=chat
 */
export function getSiliconFlowChatModel(options?: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) {
  const model =
    options?.model?.trim() ||
    process.env.SILICONFLOW_MODEL?.trim() ||
    "deepseek-ai/DeepSeek-V3.2";

  const apiKey = getApiKey();
  return new ChatOpenAI({
    model,
    apiKey,
    configuration: {
      baseURL: SILICONFLOW_BASE_URL,
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
2. 不要输出前言、解释或其它说明，仅输出大纲。`;

  const userContent = [
    `报告主题：${params.topic}`,
    params.coreContent ? `核心内容/背景补充：\n${params.coreContent}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

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
