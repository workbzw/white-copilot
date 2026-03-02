/**
 * 知识库检索：调用外部 retrieve API，将检索结果拼成可注入报告的文本。
 * 环境变量：KNOWLEDGE_API_KEY、KNOWLEDGE_BASE_URL、
 *   KNOWLEDGE_DATASET_ID（单个）或 KNOWLEDGE_DATASET_IDS（多个，逗号分隔）
 */

const DEFAULT_KNOWLEDGE_BASE_URL = "http://192.168.93.128:11014";

export type RetrievalOptions = {
  /** 指定要检索的知识库 dataset id 列表；不传则使用环境变量默认 */
  datasetIds?: string[];
  /** 检索条数（总条数，多知识库时会均分到各库），默认 5 */
  topK?: number;
  /** 是否启用重排序 */
  rerankingEnable?: boolean;
  /** 元数据过滤：document_name contains 的值，不传则不过滤 */
  documentNameContains?: string;
};

/** 从环境变量解析出要检索的知识库 dataset id 列表（支持多知识库） */
function getDatasetIds(): string[] {
  const multi = process.env.KNOWLEDGE_DATASET_IDS?.trim();
  if (multi) {
    return multi.split(",").map((id) => id.trim()).filter(Boolean);
  }
  const single = process.env.KNOWLEDGE_DATASET_ID?.trim();
  return single ? [single] : [];
}

/**
 * 从知识库检索与 query 相关的文档片段，返回拼接后的文本。
 * 支持多知识库：配置 KNOWLEDGE_DATASET_IDS=id1,id2,id3 时会依次检索并合并结果。
 * 若未配置 KNOWLEDGE_API_KEY 或任一 dataset id，返回空字符串。
 */
export async function retrieveFromKnowledge(
  query: string,
  options: RetrievalOptions = {}
): Promise<string> {
  const apiKey = process.env.KNOWLEDGE_API_KEY?.trim();
  let baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? DEFAULT_KNOWLEDGE_BASE_URL).trim().replace(/\/$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  const datasetIds = (options.datasetIds?.length ? options.datasetIds : getDatasetIds()).filter(Boolean);

  if (!apiKey || datasetIds.length === 0 || !query?.trim()) {
    if (!apiKey || datasetIds.length === 0) {
      console.log("[knowledge-retrieve] 未配置 KNOWLEDGE_API_KEY 或 KNOWLEDGE_DATASET_ID(S)，跳过检索");
    }
    return "";
  }

  const totalTopK = Math.min(20, Math.max(1, options.topK ?? 5));
  const topKPerDataset = Math.max(1, Math.ceil(totalTopK / datasetIds.length));
  const conditions =
    options.documentNameContains != null && options.documentNameContains !== ""
      ? [
          {
            name: "document_name",
            comparison_operator: "contains" as const,
            value: options.documentNameContains,
          },
        ]
      : [];

  const allChunks: string[] = [];
  /** 无命中时用于在一条日志里写清原因 */
  const apiFailures: { datasetId: string; status: number; bodyPreview: string }[] = [];
  let successEmptyCount = 0; // 200 但返回列表为空
  let successNoContentCount = 0; // 200 且列表有项，但解析不出 content

  for (const datasetId of datasetIds) {
    const payload = {
      query: query.trim(),
      retrieval_model: {
        search_method: "keyword_search",
        reranking_enable: options.rerankingEnable ?? false,
        reranking_mode: null,
        reranking_model: {
          reranking_provider_name: "",
          reranking_model_name: "",
        },
        weights: null,
        top_k: topKPerDataset,
        score_threshold_enabled: false,
        score_threshold: null,
        metadata_filtering_conditions: {
          logical_operator: "and",
          conditions,
        },
      },
    };

    const url = `${baseUrl}/v1/datasets/${encodeURIComponent(datasetId)}/retrieve`;
    const bodyStr = JSON.stringify(payload);
    const bodyBytes = Buffer.from(bodyStr, "utf8");
    const ac = new AbortController();
    const timeoutMs = 15_000;
    const timeoutId = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: bodyBytes,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text();
      const bodyPreview = text.slice(0, 300);
      apiFailures.push({ datasetId, status: res.status, bodyPreview });
      console.error("[knowledge-retrieve] API 请求失败", res.status, url, bodyPreview);
      continue;
    }

    const rawBytes = await res.arrayBuffer();
    const rawStr = new TextDecoder("utf-8").decode(rawBytes);
    const data = JSON.parse(rawStr) as {
      query?: { content?: string };
      records?: Array<{
        segment?: { content?: string; document?: { name?: string }; [key: string]: unknown };
        content?: string;
        text?: string;
        score?: number;
        [key: string]: unknown;
      }>;
      chunks?: Array<{ content?: string; text?: string }>;
      data?: Array<{ content?: string; text?: string }>;
    };
    const list =
      data.records ??
      data.chunks ??
      data.data ??
      (Array.isArray(data) ? data : []);

    const chunksBefore = allChunks.length;
    if (list.length === 0) {
      successEmptyCount += 1;
    }
    if (list.length > 0 && allChunks.length === 0 && datasetIds.indexOf(datasetId) === 0) {
      const first = list[0] as Record<string, unknown>;
      console.log("[knowledge-retrieve] 响应有 records 但未解析到 content，首条 keys:", Object.keys(first || {}));
      if (first?.segment && typeof first.segment === "object") {
        console.log("[knowledge-retrieve] 首条 segment keys:", Object.keys((first.segment as Record<string, unknown>) || {}));
      }
    }

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const content =
        (item as { segment?: { content?: string } }).segment?.content ??
        (item as { content?: string }).content ??
        (item as { text?: string }).text;
      if (typeof content === "string" && content.trim()) {
        allChunks.push(content.trim());
      }
    }
    if (list.length > 0 && allChunks.length === chunksBefore) {
      successNoContentCount += 1;
    }
  }

  const result = allChunks.join("\n\n---\n\n");
  if (allChunks.length > 0) {
    console.log("[knowledge-retrieve] 成功", {
      query: query.trim().slice(0, 50),
      knowledgeBases: datasetIds.length,
      datasetIds,
      recordCount: allChunks.length,
      totalChars: result.length,
    });
  } else {
    let reason: string;
    if (apiFailures.length === datasetIds.length) {
      reason = `所有 ${datasetIds.length} 个知识库 API 请求均失败：${apiFailures.map((f) => `${f.datasetId}→${f.status}`).join(", ")}`;
    } else if (apiFailures.length > 0) {
      reason = `部分请求失败（${apiFailures.map((f) => `${f.datasetId}→${f.status}`).join(", ")}），其余返回无有效内容`;
    } else if (successNoContentCount > 0) {
      reason = "接口返回了数据但响应格式与预期不符（需 segment.content / content / text 之一），无法解析出正文";
    } else if (successEmptyCount === datasetIds.length) {
      reason = "所有知识库均返回空结果，检索无命中";
    } else {
      reason = "未解析到任何有效正文";
    }
    console.log("[knowledge-retrieve] 无命中", {
      query: query.trim().slice(0, 50),
      knowledgeBases: datasetIds.length,
      datasetIds,
      reason,
      ...(apiFailures.length > 0 ? { apiErrors: apiFailures.map((f) => ({ id: f.datasetId, status: f.status, body: f.bodyPreview })) } : {}),
    });
  }
  if (allChunks.length === 0) return "";
  return result;
}
