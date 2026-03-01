/**
 * 使用 Axios 调用 OpenAI 兼容的 Chat API，避免 Node fetch/Request 的 ByteString 中文问题。
 */

import axios, { type AxiosInstance } from "axios";

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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const CHAT_PATH = "/v1/chat/completions";

function createClient(): AxiosInstance {
  let baseURL = getBaseUrl().replace(/\/$/, "");
  if (baseURL.endsWith("/v1")) baseURL = baseURL.slice(0, -3);
  return axios.create({
    baseURL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
  });
}

/**
 * 非流式调用：发一次请求，返回完整回复文本。
 * 请求体显式按 UTF-8 序列化，避免含中文时出现 ByteString/255 类错误。
 */
export async function chatCompletion(params: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const client = createClient();
  const payload = {
    model: params.model?.trim() || getModel(),
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 4096,
    stream: false,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await client.post<{
    choices?: Array<{ message?: { content?: string }; content?: string }>;
  }>(CHAT_PATH, body, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  const choice = res.data?.choices?.[0];
  const content = choice?.message?.content ?? (choice as { content?: string })?.content ?? "";
  return typeof content === "string" ? content : String(content ?? "");
}

/**
 * 流式调用：返回异步迭代器，收到一段就 yield 一段。
 * 请求体显式按 UTF-8 序列化，避免含中文时出现 ByteString/255 类错误。
 */
export async function* streamChatCompletion(params: {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): AsyncGenerator<string, void, unknown> {
  const client = createClient();
  const payload = {
    model: params.model?.trim() || getModel(),
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.maxTokens ?? 4096,
    stream: true,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const res = await client.post(
    CHAT_PATH,
    body,
    {
      responseType: "stream",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
  const stream = res.data as import("stream").Readable;
  const queue: string[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let streamError: Error | null = null;

  const waitNext = (): Promise<void> =>
    new Promise((resolve) => {
      if (queue.length > 0 || done) return resolve();
      resolveNext = resolve;
    });

  const push = (chunk: string) => {
    queue.push(chunk);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    buffer += str;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try {
          const data = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = data?.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content) push(content);
        } catch {
          // ignore
        }
      }
    }
  });
  stream.on("end", () => {
    if (buffer.startsWith("data: ")) {
      const raw = buffer.slice(6).trim();
      if (raw !== "[DONE]") {
        try {
          const data = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = data?.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content) push(content);
        } catch {
          // ignore
        }
      }
    }
    done = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  });
  stream.on("error", (err: Error) => {
    streamError = err;
    done = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  });

  while (true) {
    await waitNext();
    if (streamError) throw streamError;
    if (done && queue.length === 0) break;
    while (queue.length > 0) {
      const c = queue.shift();
      if (c) yield c;
    }
  }
}
