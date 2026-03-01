import { NextResponse } from "next/server";

const DEFAULT_KNOWLEDGE_BASE_URL = "http://192.168.93.128:11014";

export type KnowledgeDatasetOption = { id: string; name: string };

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

/**
 * 从知识库服务拉取数据集列表，供前端「本对话使用的知识库」选择。
 * 调用 GET {KNOWLEDGE_BASE_URL}/v1/datasets?page=1&limit=100，使用 KNOWLEDGE_API_KEY 鉴权。
 * 若未配置或请求失败，则回退到环境变量 KNOWLEDGE_DATASETS_OPTIONS（静态 JSON）。
 */
export async function GET() {
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim();
  let baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? DEFAULT_KNOWLEDGE_BASE_URL).trim().replace(/\/$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;

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
        return fallbackOptions();
      }
      const json = (await res.json()) as RemoteResponse;
      const list = json.data ?? [];
      const options: KnowledgeDatasetOption[] = (list as RemoteDataset[])
        .filter((item) => item && typeof item.id === "string" && item.id.trim())
        .map((item) => ({
          id: (item.id as string).trim(),
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : (item.id as string).trim(),
        }));
      return NextResponse.json(options);
    } catch (e) {
      console.warn("[knowledge-datasets] 知识库服务不可用，已回退:", (e as Error).message);
      return fallbackOptions();
    }
  }

  return fallbackOptions();
}

function fallbackOptions(): NextResponse<KnowledgeDatasetOption[]> {
  const raw = process.env.KNOWLEDGE_DATASETS_OPTIONS?.trim();
  if (!raw) return NextResponse.json([]);
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return NextResponse.json([]);
    const options = (list as KnowledgeDatasetOption[]).filter(
      (item) => item && typeof item.id === "string" && typeof item.name === "string"
    );
    return NextResponse.json(options);
  } catch {
    return NextResponse.json([]);
  }
}
