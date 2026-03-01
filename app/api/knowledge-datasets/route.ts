import { NextResponse } from "next/server";

const DEFAULT_KNOWLEDGE_BASE_URL = "http://192.168.93.128:11014";

export type KnowledgeDatasetOption = { id: string; name: string };

export type KnowledgeConfigStatus = {
  apiKeyConfigured: boolean;
  baseUrl: string;
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
  return { apiKeyConfigured: !!apiKey, baseUrl: baseUrl || "" };
}

/**
 * 从知识库服务拉取数据集列表，供前端「本对话使用的知识库」选择。
 * 返回 { options, configStatus }，configStatus 用于在「暂无可选知识库」时展示配置情况（不暴露 API Key 明文）。
 */
export async function GET() {
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim();
  let baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? DEFAULT_KNOWLEDGE_BASE_URL).trim().replace(/\/$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  const configStatus = getConfigStatus();

  if (apiKey) {
    try {
      const url = `${baseUrl}/v1/datasets?page=1&limit=100`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!res.ok) {
        console.warn("[knowledge-datasets] API 返回", res.status);
        return NextResponse.json({ options: fallbackOptionsList(), configStatus });
      }
      const json = (await res.json()) as RemoteResponse;
      const list = json.data ?? [];
      const options: KnowledgeDatasetOption[] = (list as RemoteDataset[])
        .filter((item) => item && typeof item.id === "string" && item.id.trim())
        .map((item) => ({
          id: (item.id as string).trim(),
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : (item.id as string).trim(),
        }));
      return NextResponse.json({ options, configStatus });
    } catch (e) {
      console.warn("[knowledge-datasets] 知识库服务不可用，已回退:", (e as Error).message);
      return NextResponse.json({ options: fallbackOptionsList(), configStatus });
    }
  }

  return NextResponse.json({ options: fallbackOptionsList(), configStatus });
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
