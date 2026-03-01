/**
 * 知识库检索：调用外部 retrieve API，将检索结果拼成可注入报告的文本。
 * 使用 Axios 而非 fetch，避免 Node fetch 在含中文响应时的 ByteString/255 报错。
 * 环境变量：KNOWLEDGE_API_KEY、KNOWLEDGE_BASE_URL、
 *   KNOWLEDGE_DATASET_ID（单个）或 KNOWLEDGE_DATASET_IDS（多个，逗号分隔）
 */

import axios from "axios";

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
    const bodyBytes = Buffer.from(JSON.stringify(payload), "utf8");
    let data: {
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
    try {
      const res = await axios.post(url, bodyBytes, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        responseType: "arraybuffer",
        validateStatus: () => true,
      });
      const rawStr = new TextDecoder("utf-8").decode(
        res.data instanceof ArrayBuffer ? res.data : new Uint8Array(res.data)
      );
      if (res.status < 200 || res.status >= 300) {
        console.error("[knowledge-retrieve] API 请求失败", res.status, url, rawStr.slice(0, 500));
        continue;
      }
      data = JSON.parse(rawStr) as typeof data;
    } catch (e) {
      console.error("[knowledge-retrieve] 请求异常", url, e);
      continue;
    }

    const list =
      data.records ??
      data.chunks ??
      data.data ??
      (Array.isArray(data) ? data : []);

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
  }

  const result = allChunks.join("\n\n---\n\n");
  if (allChunks.length > 0) {
    console.log("[knowledge-retrieve] 成功", {
      query: query.trim().slice(0, 50),
      knowledgeBases: datasetIds.length,
      recordCount: allChunks.length,
      totalChars: result.length,
    });
  } else {
    console.log("[knowledge-retrieve] 无命中", {
      query: query.trim().slice(0, 50),
      knowledgeBases: datasetIds.length,
      hint: "可能检索接口报错或返回格式不符，请查看上方是否有 API 请求失败日志",
    });
  }
  if (allChunks.length === 0) return "";
  return result;
}
