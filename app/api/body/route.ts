import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { getSystemPersona } from "@/lib/prompt-persona";
import { NO_STEP_NUMBERING_INSTRUCTION } from "@/app/api/lib/no-step-numbering-prompt";
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
    const wordCount = String(body.wordCount || "10000").trim() || "10000";
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

    // 全文生成：maxTokens 按「中文约 1 字≈1.5 token」收紧，避免允许产出远超过目标字数
    const requestedWords = Math.max(100, parseInt(wordCount, 10) || 10000);
    const maxTokens = Math.min(32768, Math.max(256, Math.ceil((requestedWords * 1.45) + 300)));
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
          topK: 6,
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
        ? `各节字数分配：全文共 ${wordCount} 字、${outline.length} 节，每节约 ${Math.round(requestedWords / outline.length)} 字，严格按此字数，写满即停、不要多写。`
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

【字数】全文字数严格以 ${wordCount} 字为准：尽量贴近，不得超过 ${wordCount} 字，宁少勿多。

【本次任务】你作为上述研究员，根据用户提供的大纲和主题，一次性输出整篇报告正文（全文生成，单次回复写完全文）。

${styleHint}

其他要求：
1. 按给定大纲逐节撰写，每节标题使用与大纲一致的格式（如一、二、三或对应标题）。
2. 【字数】全文严格不超过 ${wordCount} 字，以接近该字数为宜；字数按正文纯文字（汉字与标点）计算，不含 Markdown；勿堆砌格式，以自然段落为主。
3. 每个自然段开头缩进两格（段首空两格，即每段第一行前加两个全角空格）。
4. 【段落风格】优先用自然段落衔接，不要每段都用（一）（二）（三）（四）或 一、二、三、四 来分步。仅在确实需要明确列表（如「以下三点」「具体措施包括」等）时才使用序号；若使用，则按层级依次为：（一）（二）（三）…… → 1. 2. 3. …… → （1）（2）（3）……。章节大标题已用「一、二、三」，正文内第一层用（一），下一层用 1.，再下一层用（1）；不得跳档或混用。
5. 每一小段（每个自然段或每个分点下的内容）不少于 300 字，避免一两句话带过，需适当展开。
6. 只输出报告正文，不要输出“好的”“以下是”等前缀。
7. 使用中文，内容专业、数据与逻辑可信。
8. ${refRule}${referencesSection}

${NO_STEP_NUMBERING_INSTRUCTION}`;

    const userContent = [
      `全文字数严格不超过 ${wordCount} 字，尽量贴近该字数。`,
      `报告主题：${topic.normalize("NFC")}`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent.normalize("NFC")}` : "",
      `大纲：\n${outlineText}`,
      `${wordsPerSectionHint}请从第一条大纲开始，连续输出整篇正文，总字数严格不超过 ${wordCount} 字、尽量贴近该字数。`,
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
