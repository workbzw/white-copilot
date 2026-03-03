/**
 * 知识库检索：调用外部 retrieve API，将检索结果拼成可注入报告的文本。
 * 环境变量：KNOWLEDGE_API_KEY、KNOWLEDGE_BASE_URL、
 *   KNOWLEDGE_DATASET_ID（单个）或 KNOWLEDGE_DATASET_IDS（多个，逗号分隔）
 *
 * API 约定（与 agent-x.maas.com.cn 等兼容）：
 * - 请求：POST {BASE_URL}/datasets/{dataset_id}/retrieve
 *   Body: { query, retrieval_model: { search_method, top_k, reranking_enable, metadata_filtering_conditions, ... } }
 * - 响应：{ query: { content }, records: [ { segment: { content, document, ... }, score }, ... ] }
 * - 正文取自 records[].segment.content
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
        search_method: "hybrid_search",
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

    const url = `${baseUrl}/datasets/${encodeURIComponent(datasetId)}/retrieve`;
    if (process.env.NODE_ENV !== "production" && datasetIds.indexOf(datasetId) === 0) {
      console.log("[knowledge-retrieve] 请求", { url, query: payload.query, top_k: payload.retrieval_model.top_k });
    }
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
    const data = JSON.parse(rawStr) as Record<string, unknown> & {
      query?: { content?: string };
      records?: Array<unknown>;
      chunks?: Array<unknown>;
      data?: Array<unknown>;
      results?: Array<unknown>;
      list?: Array<unknown>;
      items?: Array<unknown>;
    };
    if (process.env.NODE_ENV !== "production") {
      console.log("[knowledge-retrieve] 响应 JSON:", JSON.stringify(data, null, 2));
    }
    const list: unknown[] =
      (data.records as unknown[] | undefined) ??
      (data.chunks as unknown[] | undefined) ??
      (data.data as unknown[] | undefined) ??
      (data.results as unknown[] | undefined) ??
      (data.list as unknown[] | undefined) ??
      (data.items as unknown[] | undefined) ??
      (Array.isArray(data) ? data : []);

    if (process.env.NODE_ENV !== "production" && list.length === 0 && Object.keys(data).length > 0) {
      const usedKey = data.records !== undefined ? "records" : data.chunks !== undefined ? "chunks" : data.data !== undefined ? "data" : data.results !== undefined ? "results" : data.list !== undefined ? "list" : data.items !== undefined ? "items" : null;
      console.log("[knowledge-retrieve] 响应根 keys:", Object.keys(data), usedKey ? `列表字段 "${usedKey}" 为空数组（检索无召回）` : "未找到列表字段 records/chunks/data/results/list/items");
    }

    const chunksBefore = allChunks.length;
    if (list.length === 0) {
      successEmptyCount += 1;
    }

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const seg = obj.segment;
      let content: string | undefined;
      if (seg && typeof seg === "object" && seg !== null) {
        const segRecord = seg as Record<string, unknown>;
        content = (segRecord["content"] ?? segRecord.content) as string | undefined;
      }
      if (typeof content !== "string" || !content.trim()) {
        content =
          (typeof obj.content === "string" ? obj.content : undefined) ??
          (typeof obj.text === "string" ? obj.text : undefined) ??
          (typeof obj.chunk_text === "string" ? obj.chunk_text : undefined) ??
          (typeof obj.segment_content === "string" ? obj.segment_content : undefined);
      }
      if (typeof content === "string" && content.trim()) {
        allChunks.push(content.trim());
      }
    }
    if (list.length > 0 && allChunks.length === chunksBefore) {
      successNoContentCount += 1;
      if (process.env.NODE_ENV !== "production") {
        const first = list[0] as Record<string, unknown>;
        const seg = first?.segment as Record<string, unknown> | undefined;
        const contentVal = seg?.content ?? seg?.["content"];
        console.log("[knowledge-retrieve] 响应有 records 但未解析到 content，首条 segment.keys:", seg ? Object.keys(seg) : [], "content 类型:", typeof contentVal, typeof contentVal === "string" ? "长度=" + contentVal.length : "");
      }
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
