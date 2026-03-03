import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { getSystemPersona } from "@/lib/prompt-persona";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 600;

export async function POST(request: NextRequest) {
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

    // 全文生成：预留足够 token，避免未写满就因上限停（中文约 1.2～1.5 token/字，系数 2.0 留余量）
    const requestedWords = Math.max(100, parseInt(wordCount, 10) || 3000);
    const maxTokens = Math.min(32768, Math.max(256, Math.ceil((requestedWords * 2.0) + 500)));
    if (process.env.NODE_ENV !== "production") {
      console.log("[body] requestedWords:", requestedWords, "maxTokens:", maxTokens);
    }

    type KnowledgeStatus = "used" | "no_api_key" | "no_dataset" | "retrieval_failed" | "no_results";
    let knowledgeText = "";
    let knowledgeStatus: KnowledgeStatus = "no_dataset";

    if (!process.env.KNOWLEDGE_API_KEY?.trim()) {
      knowledgeStatus = "no_api_key";
    } else if (knowledgeDatasetIds.length === 0) {
      knowledgeStatus = "no_dataset";
    } else {
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

    const outlineText = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const wordsPerSectionHint =
      outline.length > 0
        ? `建议各节字数分配：共约 ${wordCount} 字、${outline.length} 节，每节约 ${Math.round(requestedWords / outline.length)} 字，请按此量写足。`
        : "";
    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，正文须重点引用）】\n\n${referenceText!.trim().normalize("NFC")}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText.normalize("NFC")}`);
    }
    const referencesSection = referenceBlocks.length ? `\n\n【以下为参考资料，撰写时须按要求引用】\n\n${referenceBlocks.join("\n\n")}` : "";

    const systemPrompt = `${getSystemPersona()}

---

【本次任务】你作为上述研究员，根据用户提供的大纲和主题，一次性输出整篇报告正文（全文生成，单次回复写完全文）。

【字数硬性要求】全文总字数必须达到约 ${wordCount} 字（中文正文，含标点）。禁止在未写满约 ${wordCount} 字前结束。若某节写完后总字数仍不足，请在后续节中继续补充、展开论述，直至全文达到约 ${wordCount} 字。可略超不可明显不足。

${styleHint}

其他要求：
1. 按给定大纲逐节撰写，每节标题使用与大纲一致的格式（如一、二、三或对应标题）。
2. 字数按正文纯文字（汉字与标点）计算，不含 Markdown 符号；勿堆砌格式，以自然段落为主。
3. 只输出报告正文，不要输出“好的”“以下是”等前缀。
4. 使用中文，内容专业、数据与逻辑可信。
5. ${refRule}${referencesSection}`;

    const userContent = [
      `报告主题：${topic.normalize("NFC")}`,
      `字数要求：全文必须写满约 ${wordCount} 字（中文），禁止提前结束，务必达到约 ${wordCount} 字。${wordsPerSectionHint}`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent.normalize("NFC")}` : "",
      `大纲：\n${outlineText}`,
      `请从第一条大纲开始，连续输出整篇正文，写满约 ${wordCount} 字后再结束。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    function encodeUtf8Chunk(text: string): Uint8Array {
      return new Uint8Array(Buffer.from(text, "utf8"));
    }
    const llm = getSiliconFlowChatModel({
      temperature: 0.5,
      maxTokens,
    });
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
        try {
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
            if (!safeEnqueue(encodeUtf8Chunk(text))) break;
          }
          safeClose();
        } catch (e) {
          console.error("[body stream error]", e);
          emitError("\n\n[生成中断或出错，请重试。]");
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("[body API error]", e);
    const msg = e instanceof Error ? e.message : "生成正文失败，请稍后重试";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
