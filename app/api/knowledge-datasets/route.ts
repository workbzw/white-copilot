import { NextResponse } from "next/server";

const DEFAULT_KNOWLEDGE_BASE_URL = "http://192.168.93.128:11014";

export type KnowledgeDatasetOption = { id: string; name: string };

export type KnowledgeConfigStatus = {
  apiKeyConfigured: boolean;
  baseUrl: string;
  /** 完整请求信息，用于调试展示（不包含 API Key 明文） */
  requestInfo: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
  };
};

type RemoteDataset = {
  id?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
};

type RemoteResponse = {
  data?: RemoteDataset[];
  has_more?: boolean;
  total?: number;
  page?: number;
  limit?: number;
};

function getConfigStatus(): KnowledgeConfigStatus {
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim();
  let baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? DEFAULT_KNOWLEDGE_BASE_URL).trim().replace(/\/$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  const requestUrl = baseUrl ? `${baseUrl}/datasets?page=1&limit=100` : "";
  const requestInfo = {
    method: "GET",
    url: requestUrl,
    headers: [
      { name: "Authorization", value: apiKey ? "Bearer ***" : "(未配置)" },
      { name: "Content-Type", value: "application/json" },
    ],
  };
  return { apiKeyConfigured: !!apiKey, baseUrl: baseUrl || "", requestInfo };
}

/**
 * 从知识库服务拉取数据集列表，供前端「本对话使用的知识库」选择。
 * 返回 { options, configStatus, reason? }，options 为空时 reason 说明原因（不暴露 API Key 明文）。
 */
export async function GET() {
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim();
  let baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? DEFAULT_KNOWLEDGE_BASE_URL).trim().replace(/\/$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  const configStatus = getConfigStatus();
  const fallback = fallbackOptionsList();

  if (apiKey) {
    try {
      const url = `${baseUrl}/datasets?page=1&limit=100`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!res.ok) {
        console.warn("[knowledge-datasets] API 返回", res.status);
        const reason =
          fallback.length > 0
            ? null
            : `知识库 API 返回 HTTP ${res.status}，且未配置 KNOWLEDGE_DATASETS_OPTIONS 作为备用`;
        return NextResponse.json({ options: fallback, configStatus, reason });
      }
      const json = (await res.json()) as RemoteResponse;
      const list = json.data ?? [];
      const options: KnowledgeDatasetOption[] = (list as RemoteDataset[])
        .filter((item) => item && typeof item.id === "string" && item.id.trim())
        .map((item) => ({
          id: (item.id as string).trim(),
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : (item.id as string).trim(),
        }));
      const reason =
        options.length === 0 ? "知识库服务返回的数据集列表为空或格式无效" : null;
      return NextResponse.json({ options, configStatus, reason });
    } catch (e) {
      const errMsg = (e as Error).message;
      console.warn("[knowledge-datasets] 知识库服务不可用，已回退:", errMsg);
      const reason =
        fallback.length > 0 ? null : `知识库服务不可用：${errMsg}，且未配置 KNOWLEDGE_DATASETS_OPTIONS 作为备用`;
      return NextResponse.json({ options: fallback, configStatus, reason });
    }
  }

  const reason =
    fallback.length > 0
      ? null
      : "未配置 KNOWLEDGE_API_KEY，且未配置 KNOWLEDGE_DATASETS_OPTIONS 作为备用";
  return NextResponse.json({ options: fallback, configStatus, reason });
}

function fallbackOptionsList(): KnowledgeDatasetOption[] {
  const raw = process.env.KNOWLEDGE_DATASETS_OPTIONS?.trim();
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return (list as KnowledgeDatasetOption[]).filter(
      (item) => item && typeof item.id === "string" && typeof item.name === "string"
    );
  } catch {
    return [];
  }
}
