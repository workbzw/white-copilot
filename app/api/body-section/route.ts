import { NextRequest } from "next/server";
import { getSiliconFlowChatModel } from "@/lib/siliconflow";
import { retrieveFromKnowledge } from "@/lib/knowledge-retrieve";
import { getSystemPersona } from "@/lib/prompt-persona";
import { NO_STEP_NUMBERING_INSTRUCTION } from "@/app/api/lib/no-step-numbering-prompt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const maxDuration = 60;

/** 去掉节标题前的「一、」「二、」「第一章」「1.」等序号，仅用于知识库检索 query，提高语义匹配 */
function stripSectionNumeralPrefix(title: string): string {
  const t = title.trim();
  // 一、二、… 十一、十二、… 或 第一章、第一节、第一部分、第一项 等
  const withPunct = t.replace(
    /^\s*([一二三四五六七八九十百千零廿卅]+|[一二三四五六七八九十]+)\s*[、．.]\s*/u,
    ""
  );
  if (withPunct !== t) return withPunct.trim();
  const withChapter = t.replace(
    /^\s*第[一二三四五六七八九十百千零廿卅\d]+[章部分节项条款]\s*[、．.]?\s*/u,
    ""
  );
  if (withChapter !== t) return withChapter.trim();
  // 1. 2. 1、 或 （一）（二）
  const withArabic = t.replace(/^\s*\d+\s*[、．.]\s*/u, "");
  if (withArabic !== t) return withArabic.trim();
  const withParen = t.replace(/^\s*[（(][一二三四五六七八九十]+[)）]\s*/u, "");
  if (withParen !== t) return withParen.trim();
  return t;
}

/** 预估整段 prompt 中除「前文、引用、知识库」外的字符数（系统提示 + 用户指令等） */
const ESTIMATED_OTHER_PROMPT_CHARS = 3500;
/** 为本节输出预留的字符数（按 token 约 1.5 字估算），避免前文挤占导致输出被截断 */
const RESERVE_OUTPUT_CHARS = 2500;
/** 32B 等模型上下文大致可用的输入字符数（留余量），与知识库+引用+前文共享 */
const CONTEXT_BUDGET_CHARS = 18000;
/** 前文最少保留字符数，保证续写连贯；引用+知识库合起来不超过剩余预算（与下一条合计 6000+6000） */
const MIN_PREVIOUS_CHARS = 6000;

/**
 * 按节生成报告正文，支持顺序续写：传入已生成前文，本节在其基础上连贯续写。
 * POST body: { outline, topic, sectionIndex, wordCountPerSection?, previousSectionsContent?, reportTemplate?, coreContent?, styleMode? }
 * 返回 stream: 本节正文文本
 */
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
    const sectionIndex = Number(body.sectionIndex);
    const sectionTitle =
      outline?.[sectionIndex] ?? `第 ${sectionIndex + 1} 节`;
    const wordCountPerSection = Math.max(
      20,
      Math.floor(Number(body.wordCountPerSection) || 600)
    );
    // 中文约 1 字≈1.5 token，收紧上限避免单节产出远超 wordCountPerSection（导致总字数超标）
    const maxTokens = Math.min(16384, Math.max(128, Math.ceil((wordCountPerSection * 1.5) + 150)));
    if (process.env.NODE_ENV !== "production") {
      console.log("[body-section] wordCountPerSection:", wordCountPerSection, "maxTokens:", maxTokens);
    }

    const reportTemplate = (body.reportTemplate as string)?.trim() || "公告模板";
    const coreContent = (body.coreContent as string)?.trim() || "";
    const styleMode = body.styleMode === "standard" ? "standard" : "ai";
    let previousSectionsContent = (body.previousSectionsContent as string)?.trim() || "";
    const referenceText = (body.referenceText as string)?.trim() || "";
    const rawIds = body.knowledgeDatasetIds;
    const knowledgeDatasetIds: string[] = Array.isArray(rawIds)
      ? (rawIds as unknown[]).filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : typeof rawIds === "string"
        ? rawIds.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    type KnowledgeStatus = "used" | "no_api_key" | "no_dataset" | "retrieval_failed" | "no_results";
    // 快速生成：知识库检索用「总标题 + 当前节标题（去掉一、二、等序号）」避免序号干扰语义匹配
    const sectionTitleForQuery = stripSectionNumeralPrefix(sectionTitle);
    const sectionQuery = `${topic} ${sectionTitleForQuery}`.trim();
    let knowledgeText = "";
    let knowledgeStatus: KnowledgeStatus = "no_dataset";

    if (!process.env.KNOWLEDGE_API_KEY?.trim()) {
      knowledgeStatus = "no_api_key";
    } else if (knowledgeDatasetIds.length === 0) {
      knowledgeStatus = "no_dataset";
    } else {
      try {
        knowledgeText = await retrieveFromKnowledge(sectionQuery, {
          topK: 6,
          datasetIds: knowledgeDatasetIds,
        });
        if (knowledgeText?.trim()) {
          knowledgeStatus = "used";
        } else {
          knowledgeStatus = "no_results";
        }
      } catch (e) {
        console.warn("[body-section] 知识库检索失败，继续生成本节", e);
        knowledgeStatus = "retrieval_failed";
      }
    }
    const hasLocalRef = !!referenceText;
    const hasKnowledge = knowledgeStatus === "used";

    if (!outline?.length || !topic || !Number.isInteger(sectionIndex) || sectionIndex < 0) {
      return new Response(
        JSON.stringify({ error: "缺少报告主题、大纲或节序号" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const styleHint =
      styleMode === "standard"
        ? "请严格按标准公文格式与用语撰写，层次清晰、用语规范。"
        : "可适当发挥，保持专业、条理清晰。";

    const refRule =
      hasLocalRef && hasKnowledge
        ? "若同时提供了本地引用文章与知识库检索结果，则重点引用本地文章，适当引用知识库作为补充。"
        : "若用户提供了重点引用资料，本节正文中必须引用其中的关键数据、表述或观点，应明确体现资料内容，不得完全脱离资料发挥。";

    const referenceBlocks: string[] = [];
    if (hasLocalRef) {
      referenceBlocks.push(`【重点引用资料（本地文章，本节须重点引用）】\n\n${referenceText.normalize("NFC")}`);
    }
    if (hasKnowledge) {
      referenceBlocks.push(`【知识库检索（可适当引用补充）】\n\n${knowledgeText.normalize("NFC")}`);
    }
    let referencesSection = referenceBlocks.length ? `\n\n【以下为参考资料，撰写时须按要求引用】\n\n${referenceBlocks.join("\n\n")}` : "";

    // 前文与引用+知识库各约 6000 字：为前文预留至少 MIN_PREVIOUS_CHARS，引用+知识库合起来不得超过剩余预算
    const MAX_REF_AND_KNOWLEDGE_CHARS = 6000;
    const maxRefAndKnowledgeChars = Math.min(
      MAX_REF_AND_KNOWLEDGE_CHARS,
      Math.max(0, CONTEXT_BUDGET_CHARS - ESTIMATED_OTHER_PROMPT_CHARS - RESERVE_OUTPUT_CHARS - MIN_PREVIOUS_CHARS)
    );
    if (referencesSection.length > maxRefAndKnowledgeChars) {
      referencesSection = referencesSection.slice(0, maxRefAndKnowledgeChars) + "\n\n[参考资料已截断，前文连贯优先]";
    }
    const refAndKnowledgeChars = referencesSection.length;
    const maxPreviousChars = Math.max(
      MIN_PREVIOUS_CHARS,
      CONTEXT_BUDGET_CHARS - ESTIMATED_OTHER_PROMPT_CHARS - refAndKnowledgeChars - RESERVE_OUTPUT_CHARS
    );
    if (previousSectionsContent.length > maxPreviousChars) {
      previousSectionsContent = previousSectionsContent.slice(-maxPreviousChars);
    }
    if (process.env.NODE_ENV !== "production" && (referencesSection.includes("已截断") || (body.previousSectionsContent as string)?.length > maxPreviousChars)) {
      console.log("[body-section] ref+knowledge", refAndKnowledgeChars, "chars; previousSectionsContent up to", maxPreviousChars, "chars");
    }

    const previousContextBlock = previousSectionsContent
      ? `

【已生成前文（请在此基础上续写，保持文风、数据与逻辑连贯，勿重复前文）】
---
${previousSectionsContent}
---
以上为前文，请只续写下一节正文，不要重复前文内容。
`
      : "";

    const systemPrompt = `${getSystemPersona()}

---

【字数】本节字数严格以 ${wordCountPerSection} 字为准：尽量贴近，不得超过 ${wordCountPerSection} 字，宁少勿多。

【本次任务】你作为上述研究员，根据报告主题和大纲，只撰写其中某一节的内容。${previousSectionsContent ? "本节为续写，请与上文自然衔接。" : ""}
${styleHint}
要求：
1. 本节标题为：${sectionTitle}。禁止在正文开头重复该标题（不要再次写「${sectionTitle}」或「一、」「二、」等段落标题），直接从第一段正文开始，只写标题下方的正文。
2. 【字数】本节严格不超过 ${wordCountPerSection} 字，以接近该字数为宜；字数按正文纯文字计算，不含 Markdown；勿堆砌格式，以自然段落为主。
3. 【段落格式】每个自然段开头缩进两格（段首空两格，即每段第一行前加两个全角空格）。
4. 【段落风格】优先用自然段落衔接，不要每段都用（一）（二）（三）（四）或 一、二、三、四 来分步。仅在确实需要明确列表（如「以下三点」「具体措施包括」等）时才使用序号；若使用，则按层级依次为：（一）（二）（三）…… → 1. 2. 3. …… → （1）（2）（3）……。章节大标题已用「一、二、三」，正文内第一层用（一），下一层用 1.，再下一层用（1）；不得跳档或混用（如 1. 下面再用（一）则错，应用（1））。
5. 【小段篇幅】每一小段（每个自然段或每个分点下的内容）不少于 300 字，避免一两句话带过，需适当展开。
6. 只输出本节正文，不要输出“好的”“以下是”等前缀，不要写其他节；开头不要有任何无关内容（如寒暄、标题重复、过渡句等），直接输出正文第一段。
7. 使用中文，内容专业、数据与逻辑可信。
8. ${refRule}${referencesSection}${previousContextBlock}

${NO_STEP_NUMBERING_INSTRUCTION}`;

    const outlineContext = outline.map((item, i) => `${i + 1}. ${item}`).join("\n");
    const userContent = [
      `本节字数严格不超过 ${wordCountPerSection} 字，尽量贴近该字数。`,
      `报告主题：${topic.normalize("NFC")}`,
      `报告模板：${reportTemplate}`,
      coreContent ? `背景与要点：\n${coreContent}` : "",
      `全文大纲（供参考）：\n${outlineContext}`,
      previousSectionsContent
        ? `请紧接前文，只撰写第 ${sectionIndex + 1} 节「${sectionTitle}」的正文，本节严格不超过 ${wordCountPerSection} 字、尽量贴近该字数。保持与前文风格、术语一致。`
        : `请只撰写第 ${sectionIndex + 1} 节「${sectionTitle}」的正文，本节严格不超过 ${wordCountPerSection} 字、尽量贴近该字数。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    function encodeUtf8Chunk(text: string): Uint8Array {
      return new Uint8Array(Buffer.from(text, "utf8"));
    }
    const llm = getSiliconFlowChatModel({
      temperature: 0.6,
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
            // ignore
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
          console.error("[body-section stream error]", e);
          emitError("\n[本节生成中断或出错]");
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
    console.error("[body-section API error]", e);
    const msg = e instanceof Error ? e.message : "本节生成失败，请重试";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
