import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 120;

/** 包装 fetch：将字符串 body 转为 UTF-8 Buffer，避免 Node/undici 按 ByteString 处理中文导致报错 */
function patchFetchForUtf8Body(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (init?.body != null && typeof init.body === "string") {
      init = { ...init, body: Buffer.from(init.body, "utf8") };
    }
    return orig(input, init);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

export async function POST(request: NextRequest) {
  const restoreFetch = patchFetchForUtf8Body();
  try {
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (!raw?.trim()) {
        return new Response(
          JSON.stringify({ error: "请求体为空" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response(
        JSON.stringify({ error: "请求体不是有效 JSON" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const outline = body.outline as string[] | undefined;
    const topic = (body.topic as string)?.trim() || "";
    const wordCount = String(body.wordCount || "3000").trim() || "3000";
    const reportTemplate = (body.reportTemplate as string)?.trim() || "公告模板";
    const coreContent = (body.coreContent as string)?.trim() || "";
    const styleMode = body.styleMode === "standard" ? "standard" : "ai";
    const referenceText = (body.referenceText as string)?.trim() || "";
    const rawIds = body.knowledgeDatasetIds;
    const knowledgeDatasetIds: string[] = Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : typeof rawIds === "string"
        ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

    if (!outline?.length || !topic) {
      return new Response(
        JSON.stringify({ error: "缺少报告主题或大纲" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 按用户目标字数限制：中文约 1～1.5 字/token，maxTokens 收紧以免超出字数太多
    const requestedWords = Math.max(100, parseInt(wordCount, 10) || 3000);
    const maxTokens = Math.min(32768, Math.max(256, Math.ceil((requestedWords * 1.2) + 100)));

    const llm = getSiliconFlowChatModel({
      temperature: 0.6,
      maxTokens,
    });

    type KnowledgeStatus = "used" | "no_api_key" | "no_dataset" | "retrieval_failed" | "no_results";
    let knowledgeText = "";
    let knowledgeStatus: KnowledgeStatus = "no_dataset";
    let knowledgeQuerySent = "";

    if (!process.env.KNOWLEDGE_API_KEY?.trim()) {
      knowledgeStatus = "no_api_key";
    } else if (knowledgeDatasetIds.length === 0) {
      knowledgeStatus = "no_dataset";
    } else {
      knowledgeQuerySent = topic;
      try {
        knowledgeText = await retrieveFromKnowledge(topic, {
          topK: 5,
          datasetIds: knowledgeDatasetIds,
        });
        if (knowledgeText?.trim()) {
          knowledgeStatus = "used";
        } else {
          knowledgeStatus = "no_results";
        }
      } catch (e) {
        console.warn("[body] 知识库检索失败，继续生成正文", e);
        knowledgeStatus = "retrieval_failed";
      }
    }
    const hasLocalRef = !!referenceText?.trim();
    const hasKnowledge = knowledgeStatus === "used";

    if (knowledgeQuerySent) {
      console.log("[知识库检索] 全文", {
        检索关键词: knowledgeQuerySent,
        状态: knowledgeStatus,
        命中条数: hasKnowledge ? knowledgeText.split("\n\n---\n\n").length : 0,
      });
      if (knowledgeText) {
        console.log("[知识库检索结果] 全文注入内容：", knowledgeText);
      }
    }

    const outlineText = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const systemPrompt = `你是一名专业报告撰写助手。请根据用户提供的大纲和主题，撰写完整报告正文。
${styleHint}
要求：
1. 按给定大纲逐节撰写，每节标题使用与大纲一致的格式（如一、二、三或对应标题）。
2. 总字数须控制在 ${wordCount} 字以内，约 ${wordCount} 字即可，不要超过 ${wordCount} 字。按大纲合理分配到各节。
3. 只输出报告正文，不要输出“好的”“以下是”等前缀。
4. 使用中文，内容专业、数据与逻辑可信。
5. ${refRule}`;

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，正文须重点引用）】\n\n${referenceText!.trim().normalize("NFC")}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText.normalize("NFC")}`);
    }

    const userContent = [
      `报告主题：${topic.normalize("NFC")}`,
      `字数要求：全文控制在 ${wordCount} 字以内，约 ${wordCount} 字，不要超过 ${wordCount} 字`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent.normalize("NFC")}` : "",
      referenceBlocks.length ? referenceBlocks.join("\n\n") : "",
      `大纲：\n${outlineText}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    /** 将 UTF-8 文本编码为流式 chunk，避免 ByteString（仅 0–255）导致的报错 */
    function encodeUtf8Chunk(text: string): Uint8Array {
      return new Uint8Array(Buffer.from(text, "utf8"));
    }
    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: Uint8Array) => {
          try {
            controller.enqueue(data);
            return true;
          } catch {
            return false;
          }
        };
        const safeClose = () => {
          try {
            controller.close();
          } catch {
            // 客户端已断开，忽略
          }
        };
        const emitError = (userMsg: string) => {
          safeEnqueue(encodeUtf8Chunk(userMsg));
          safeClose();
        };
        const origFetch = globalThis.fetch;
        globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
          if (init?.body != null && typeof init.body === "string") {
            init = { ...init, body: Buffer.from(init.body, "utf8") };
          }
          return origFetch(input, init);
        };
        try {
          // 流开头始终写一行知识库状态与结果，供前端控制台展示（无论检索成没成功）
          const knowledgeRecordCountMeta = hasKnowledge ? knowledgeText.split("\n\n---\n\n").length : 0;
          const metaLine =
            JSON.stringify({
              _knowledgeStatus: knowledgeStatus,
              _knowledgeQuery: knowledgeQuerySent,
              _knowledgeRecordCount: knowledgeRecordCountMeta,
              _knowledgeText: knowledgeText || "",
            }) + "\n";
          safeEnqueue(encodeUtf8Chunk(metaLine));
          const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(userContent),
          ];
          const llmStream = await llm.stream(messages);
          for await (const chunk of llmStream) {
            const text =
              typeof chunk.content === "string"
                ? chunk.content
                : String(chunk.content ?? "");
            if (!text) continue;
            try {
              if (!safeEnqueue(encodeUtf8Chunk(text))) break;
            } catch (encodeErr) {
              const msg = (encodeErr as Error).message || "";
              if (/ByteString|greater than 255/i.test(msg)) {
                console.error("[body stream] 流片段编码异常（ByteString/非 Latin-1），已跳过该片段", msg);
              } else throw encodeErr;
            }
          }
          safeClose();
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("[body stream error]", e);
          if (/ByteString|greater than 255|24180/i.test(errMsg)) {
            emitError("\n\n[生成失败：当前环境无法正确处理含中文的知识库或引用内容，请尝试不勾选知识库、缩短引用后再试，或联系管理员。]");
          } else {
            emitError("\n\n[生成中断或出错，请重试。]");
          }
        } finally {
          globalThis.fetch = origFetch;
        }
      },
    });

    const knowledgeRecordCount = hasKnowledge ? knowledgeText.split("\n\n---\n\n").length : 0;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Knowledge-Used": hasKnowledge ? "true" : "false",
        "X-Knowledge-Status": knowledgeStatus,
        "X-Knowledge-Query": knowledgeQuerySent,
        "X-Knowledge-Record-Count": String(knowledgeRecordCount),
      },
    });
  } catch (e) {
    console.error("[body API error]", e);
    restoreFetch();
    const msg = e instanceof Error ? e.message : "生成正文失败，请稍后重试";
    const safeMsg =
      /ByteString|greater than 255|24180/i.test(msg)
        ? "生成正文失败：当前环境无法正确处理含中文的引用或知识库内容，请尝试不勾选知识库或缩短引用后再试。"
        : msg;
    return new Response(
      JSON.stringify({ error: safeMsg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
