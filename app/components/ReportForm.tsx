"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { marked } from "marked";

const STEPS = [
  { id: "outline", label: "生成大纲" },
  { id: "body", label: "生成正文" },
  { id: "optimize", label: "内容优化" },
] as const;

/** 技术性错误（如 URL、fetch）不展示在正文框，改为友好提示 */
function sanitizeBodyError(msg: string): string {
  if (!msg || typeof msg !== "string") return "生成失败，请重试";
  const t = msg.trim();
  if (
    /failed to parse url|parse URL|ECONNREFUSED|fetch failed|getaddrinfo|network/i.test(t) ||
    /^\d+\.\d+\.\d+\.\d+:\d+/m.test(t) ||
    t.length > 150
  )
    return "生成失败，请稍后重试";
  return t;
}

type StyleMode = "ai" | "standard";

export type ReportFormInitialData = {
  topic: string;
  outline: string[];
  body: string;
  title?: string;
  /** 重点引用资料全文，生成正文时会传给模型以优先引用 */
  referenceText?: string;
  /** 本文档使用的知识库 id 列表，空则使用系统默认 */
  knowledgeDatasetIds?: string[];
};

type ReportFormProps = {
  userId?: string;
  docId?: string;
  initialData?: ReportFormInitialData;
};

export default function ReportForm({ userId, docId, initialData }: ReportFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<"outline" | "body" | "optimize">("outline");
  const [topic, setTopic] = useState("");
  const [coreContent, setCoreContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [styleMode, setStyleMode] = useState<StyleMode>("ai");
  const [outline, setOutline] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState("100");
  const [reportTemplate, setReportTemplate] = useState("公告模板");
  const [bodyGenMode, setBodyGenMode] = useState<"full" | "sections">("full");
  const [referenceText, setReferenceText] = useState("");
  const [knowledgeDatasetOptions, setKnowledgeDatasetOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedKnowledgeDatasetIds, setSelectedKnowledgeDatasetIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [bodyContent, setBodyContent] = useState("");
  const [contentHistoryState, setContentHistoryState] = useState<{
    history: string[];
    index: number;
  }>({ history: [], index: -1 });
  const [bodySections, setBodySections] = useState<string[]>([]);
  const [bodyProgress, setBodyProgress] = useState(0);
  const [isBodyGenerating, setIsBodyGenerating] = useState(false);
  const [bodyCompleted, setBodyCompleted] = useState(false);
  const [aiToolLoading, setAiToolLoading] = useState<"polish" | "simplify" | "expand" | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [saveMdLoading, setSaveMdLoading] = useState(false);
  const [saveMdError, setSaveMdError] = useState<string | null>(null);
  const [toolbarActive, setToolbarActive] = useState({
    bold: false,
    italic: false,
    underline: false,
    justifyLeft: false,
    justifyCenter: false,
    justifyRight: false,
    justifyFull: false,
  });
  const bodyAbortRef = useRef<AbortController | null>(null);
  const bodyShouldStartRef = useRef(true);
  const bodyContentScrollRef = useRef<HTMLDivElement>(null);
  const previewEditableRef = useRef<HTMLDivElement>(null);
  const bodySectionsRef = useRef<string[]>([]);
  /** 点击格式按钮时保存的选区，避免点击导致选区丢失 */
  const savedRangeRef = useRef<Range | null>(null);

  const CONCURRENCY = 3;

  /** 根据当前选区更新工具栏按钮高亮 */
  const updateToolbarState = useCallback(() => {
    if (!previewEditableRef.current?.contains(document.activeElement)) return;
    setToolbarActive({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      justifyLeft: document.queryCommandState("justifyLeft"),
      justifyCenter: document.queryCommandState("justifyCenter"),
      justifyRight: document.queryCommandState("justifyRight"),
      justifyFull: document.queryCommandState("justifyFull"),
    });
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", updateToolbarState);
    return () => document.removeEventListener("selectionchange", updateToolbarState);
  }, [updateToolbarState]);

  const buildFullTextFromSections = useCallback(
    (sections: string[]) => {
      if (!outline?.length) return "";
      return outline
        .map((title, i) => `## ${title}\n\n${sections[i] ?? ""}`)
        .join("\n\n")
        .trim();
    },
    [outline]
  );

  /** 确保章节标题为 h2(##)、段落标题为 h3(###)，便于 ReactMarkdown 正确渲染 */
  const ensureSectionHeadersAsH2 = useCallback(
    (text: string) => {
      if (!text.trim()) return text;
      const outlineSet = new Set(outline?.map((t) => t.trim()) ?? []);
      return text
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (/^#{1,3}\s+/.test(line)) return line;
          if (outlineSet.has(t)) return "## " + line;
          if (/^[一二三四五六七八九十百千零廿卅]+[、.]\s*.+/.test(t)) return "## " + line;
          if (/^[（(][一二三四五六七八九十百千零廿卅]+[)）]\s*.+/.test(t)) return "### " + line;
          if (/^\d+[.．]\s+.{1,80}$/.test(t)) return "### " + line;
          return line;
        })
        .join("\n");
    },
    [outline]
  );

  const MAX_HISTORY = 50;
  /** 将新内容加入历史（生成完成、润色/精简/扩充等任何改动后调用） */
  const addToContentHistory = useCallback((content: string) => {
    setContentHistoryState((prev) => {
      const next =
        prev.index < 0
          ? [content]
          : [...prev.history.slice(0, prev.index + 1), content];
      const history = next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      return { history, index: history.length - 1 };
    });
    setBodyContent(content);
  }, []);

  const handleContentUndo = useCallback(() => {
    setContentHistoryState((prev) => {
      if (prev.index <= 0) return prev;
      const newIndex = prev.index - 1;
      const html = prev.history[newIndex];
      setBodyContent(html);
      if (previewEditableRef.current) previewEditableRef.current.innerHTML = html;
      return { ...prev, index: newIndex };
    });
  }, []);

  const handleContentRedo = useCallback(() => {
    setContentHistoryState((prev) => {
      if (prev.index >= prev.history.length - 1) return prev;
      const newIndex = prev.index + 1;
      const html = prev.history[newIndex];
      setBodyContent(html);
      if (previewEditableRef.current) previewEditableRef.current.innerHTML = html;
      return { ...prev, index: newIndex };
    });
  }, []);

  /** 可选知识库列表（用于本对话选择不同知识库） */
  useEffect(() => {
    fetch("/api/knowledge-datasets")
      .then((r) => r.json())
      .then((list) => setKnowledgeDatasetOptions(Array.isArray(list) ? list : []))
      .catch(() => setKnowledgeDatasetOptions([]));
  }, []);

  /** 编辑已有文档：用 initialData 填充并进入正文/优化步骤（须在 addToContentHistory 之后） */
  const initialDataApplied = useRef(false);
  useEffect(() => {
    if (!initialData || initialDataApplied.current) return;
    initialDataApplied.current = true;
    setTopic(initialData.topic || "");
    if (initialData.outline?.length) {
      setOutline(initialData.outline);
      setStep("body");
    }
    if (typeof initialData.referenceText === "string" && initialData.referenceText.trim()) {
      setReferenceText(initialData.referenceText.trim());
    }
    if (Array.isArray(initialData.knowledgeDatasetIds)) {
      setSelectedKnowledgeDatasetIds(initialData.knowledgeDatasetIds.filter((id) => typeof id === "string"));
    }
    if (initialData.body?.trim()) {
      addToContentHistory(initialData.body);
      setBodyCompleted(true);
      setStep("optimize");
    }
  }, [initialData, addToContentHistory]);

  const editableOutline = outline ?? [];

  const removeOutlineItem = (index: number) => {
    if (!outline) return;
    setOutline(outline.filter((_, i) => i !== index));
  };

  const addOutlineItem = () => {
    setOutline([...(outline ?? []), "新目录项"]);
  };

  const updateOutlineItem = (index: number, value: string) => {
    if (!outline) return;
    setOutline(outline.map((item, i) => (i === index ? value : item)));
  };

  const handleRegenerateOutline = () => {
    setError(null);
    handleGenerateOutline(true);
  };

  const handleConfirmOutline = () => {
    setStep("body");
  };

  const startBodyStream = useCallback(async () => {
    if (!outline?.length || !topic.trim()) return;
    const ac = new AbortController();
    bodyAbortRef.current = ac;
    setBodyContent("");
    setBodyProgress(0);
    setBodyCompleted(false);
    setIsBodyGenerating(true);
    setBodySections(bodyGenMode === "sections" ? outline.map(() => "") : []);

    if (bodyGenMode === "full") {
      try {
        const res = await fetch("/api/body", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outline,
            topic,
            wordCount,
            reportTemplate,
            coreContent: coreContent || undefined,
            styleMode,
            referenceText: referenceText || undefined,
            knowledgeDatasetIds: selectedKnowledgeDatasetIds.length ? selectedKnowledgeDatasetIds : undefined,
          }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const raw = (data.error as string) || "生成失败，请重试";
          setBodyContent(sanitizeBodyError(raw));
          return;
        }
        const knowledgeUsed = res.headers.get("X-Knowledge-Used") === "true";
        const knowledgeQuery = res.headers.get("X-Knowledge-Query") ?? "";
        const knowledgeCount = res.headers.get("X-Knowledge-Record-Count") ?? "0";
        console.log("[知识库检索] 全文生成", {
          检索方式: "报告主题",
          检索关键词: knowledgeQuery || "(未使用知识库)",
          是否检索到内容: knowledgeUsed,
          命中条数: Number(knowledgeCount) || 0,
        });
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) {
          setBodyContent("生成失败，请重试");
          return;
        }
        let text = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          setBodyContent(text);
          setBodyProgress((p) => Math.min(99, p + 1));
        }
        setBodyProgress(100);
        setBodyCompleted(true);
        addToContentHistory(text);
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setBodyContent((prev) => prev || "[已终止生成]");
        } else {
          const msg = e instanceof Error ? e.message : "生成异常，请重试";
          setBodyContent((prev) => prev || sanitizeBodyError(msg));
        }
      } finally {
        setIsBodyGenerating(false);
        bodyAbortRef.current = null;
      }
      return;
    }

    const totalWordCount = parseInt(wordCount, 10) || 100;
    const wordCountPerSection = Math.max(20, Math.floor(totalWordCount / outline.length));
    const results = outline.map(() => "");
    bodySectionsRef.current = results;
    let completedCount = 0;
    const runSectionStream = async (index: number): Promise<void> => {
      const res = await fetch("/api/body-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outline,
          topic,
          sectionIndex: index,
          wordCountPerSection,
          reportTemplate,
          coreContent: coreContent || undefined,
          styleMode,
          referenceText: referenceText || undefined,
          knowledgeDatasetIds: selectedKnowledgeDatasetIds.length ? selectedKnowledgeDatasetIds : undefined,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data.error as string) || `第 ${index + 1} 节生成失败`);
      }
      const knowledgeUsed = res.headers.get("X-Knowledge-Used") === "true";
      const knowledgeQuery = res.headers.get("X-Knowledge-Query") ?? "";
      const knowledgeCount = res.headers.get("X-Knowledge-Record-Count") ?? "0";
      console.log(`[知识库检索] 第 ${index + 1} 节`, {
        检索方式: "报告主题 + 本节标题",
        检索关键词: knowledgeQuery || "(未使用知识库)",
        是否检索到内容: knowledgeUsed,
        命中条数: Number(knowledgeCount) || 0,
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("无法读取响应流");
      let sectionText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sectionText += decoder.decode(value, { stream: true });
        bodySectionsRef.current[index] = sectionText;
        setBodySections([...bodySectionsRef.current]);
      }
      completedCount += 1;
      setBodyProgress(Math.round((completedCount / outline.length) * 100));
    };

    try {
      let nextIndex = 0;
      const runNext = async (): Promise<void> => {
        while (nextIndex < outline.length && !ac.signal.aborted) {
          const i = nextIndex++;
          await runSectionStream(i);
        }
      };
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, outline.length) },
        () => runNext()
      );
      await Promise.all(workers);
      if (ac.signal.aborted) return;
      const fullText = buildFullTextFromSections(bodySectionsRef.current);
      addToContentHistory(fullText);
      setBodyProgress(100);
      setBodyCompleted(true);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setBodyContent((prev) => prev || "[已终止生成]");
      } else {
        const msg = e instanceof Error ? e.message : "生成异常，请重试";
        setBodyContent((prev) => prev || sanitizeBodyError(msg));
      }
    } finally {
      setIsBodyGenerating(false);
      bodyAbortRef.current = null;
    }
  }, [outline, topic, wordCount, reportTemplate, coreContent, styleMode, bodyGenMode, referenceText, selectedKnowledgeDatasetIds, buildFullTextFromSections, addToContentHistory]);

  useEffect(() => {
    if (step !== "body") {
      bodyShouldStartRef.current = true;
      return;
    }
    if (
      bodyShouldStartRef.current &&
      outline?.length &&
      topic.trim()
    ) {
      bodyShouldStartRef.current = false;
      startBodyStream();
    }
    return () => {
      bodyAbortRef.current?.abort();
    };
  }, [step, outline, topic, startBodyStream]);

  useEffect(() => {
    if (!bodyContentScrollRef.current) return;
    bodyContentScrollRef.current.scrollTop = bodyContentScrollRef.current.scrollHeight;
  }, [bodyContent, bodySections]);

  useEffect(() => {
    if (step === "optimize" && bodyContent && contentHistoryState.history.length === 0) {
      setContentHistoryState({ history: [bodyContent], index: 0 });
    }
  }, [step, bodyContent, contentHistoryState.history.length]);

  // 内容优化：将 bodyContent（富文本 HTML）同步到可编辑预览区（仅在未聚焦时）
  useEffect(() => {
    if (step !== "optimize" || !previewEditableRef.current) return;
    if (previewEditableRef.current?.contains(document.activeElement)) return;
    previewEditableRef.current.innerHTML = bodyContent || "";
  }, [step, bodyContent]);

  const handlePreviewEditableBlur = useCallback(() => {
    const el = previewEditableRef.current;
    if (!el) return;
    const html = el.innerHTML || "";
    if (html !== bodyContent) addToContentHistory(html);
  }, [bodyContent, addToContentHistory]);


  const handleAbortBody = () => {
    bodyAbortRef.current?.abort();
    setStep("outline");
  };

  const handleRegenerateBody = () => {
    setBodyContent("");
    setBodySections([]);
    setBodyProgress(0);
    setBodyCompleted(false);
    startBodyStream();
  };

  const handleEnterOptimize = () => {
    const md = ensureSectionHeadersAsH2(bodyContent || "");
    const html = md ? (marked.parse(md) as string) : "";
    setBodyContent(html);
    setContentHistoryState(html ? { history: [html], index: 0 } : { history: [], index: -1 });
    setStep("optimize");
  };

  const isPreviewEditableFocused = () =>
    previewEditableRef.current?.contains(document.activeElement) ?? false;

  /** 点击格式按钮时在 mousedown 阶段保存选区，避免点击导致选区丢失 */
  const saveSelectionForFormat = useCallback(() => {
    const el = previewEditableRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    savedRangeRef.current = range.cloneRange();
  }, []);

  /** 执行富文本格式命令（粗体/斜体/下划线/对齐），执行后同步内容到 state 与历史 */
  const execRichTextFormat = useCallback(
    (command: "bold" | "italic" | "underline" | "justifyLeft" | "justifyCenter" | "justifyRight" | "justifyFull") => {
      const el = previewEditableRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (sel && savedRangeRef.current) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
        savedRangeRef.current = null;
      }
      document.execCommand(command, false);
      const html = el.innerHTML || "";
      setBodyContent(html);
      addToContentHistory(html);
      setTimeout(updateToolbarState, 0);
    },
    [addToContentHistory, updateToolbarState]
  );

  const runAiTool = useCallback(
    async (action: "polish" | "simplify" | "expand") => {
      const el = previewEditableRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return;
      }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) {
        return;
      }
      const selectedText = sel.toString().trim();
      if (!selectedText) {
        return;
      }
      setAiToolLoading(action);
      try {
        const res = await fetch("/api/polish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: selectedText, action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return;
        }
        const resultText = (data as { text?: string }).text ?? "";
        if (!resultText) return;
        range.deleteContents();
        range.insertNode(document.createTextNode(resultText));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        addToContentHistory(el.innerHTML || "");
      } finally {
        setAiToolLoading(null);
      }
    },
    [addToContentHistory]
  );

  /** 获取当前正文富文本 HTML（优化步骤取 contentEditable，正文步骤由 Markdown 转 HTML） */
  const getCurrentBodyHtml = useCallback(() => {
    if (step === "optimize" && previewEditableRef.current) {
      return previewEditableRef.current.innerHTML || bodyContent;
    }
    if (isBodyGenerating && bodySections.length && outline?.length) {
      const md = buildFullTextFromSections(bodySections);
      return md ? (marked.parse(ensureSectionHeadersAsH2(md)) as string) : "";
    }
    const md = ensureSectionHeadersAsH2(bodyContent || "");
    return md ? (marked.parse(md) as string) : "";
  }, [step, bodyContent, isBodyGenerating, bodySections, outline, buildFullTextFromSections, ensureSectionHeadersAsH2]);

  /** 富文本 HTML 导出为 Word（调用服务端 html-to-docx） */
  const exportAsWord = useCallback(async (contentHtml?: string) => {
    const html = contentHtml != null ? contentHtml : getCurrentBodyHtml();
    const body = (typeof html === "string" && html.trim()) ? html : "<p></p>";
    const res = await fetch("/api/export-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(err);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(topic || "报告").slice(0, 20)}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    setExportSuccess(true);
  }, [topic, getCurrentBodyHtml]);

  /** 保存富文本文档到服务端（需 userId） */
  const saveDocument = useCallback(async () => {
    if (!userId) return;
    setSaveMdError(null);
    setSaveMdLoading(true);
    try {
      const title = (topic || "未命名文档").slice(0, 100);
      const outlineList = outline ?? [];
      const body = getCurrentBodyHtml();
      const url = docId
        ? `/api/users/${encodeURIComponent(userId)}/docs/${encodeURIComponent(docId)}`
        : `/api/users/${encodeURIComponent(userId)}/docs`;
      const method = docId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          topic,
          outline: outlineList,
          body,
          referenceText: referenceText || undefined,
          knowledgeDatasetIds: selectedKnowledgeDatasetIds.length ? selectedKnowledgeDatasetIds : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMdError(data.error || "保存失败");
        return;
      }
      if (!docId && data.id) {
        router.replace(`/user/${encodeURIComponent(userId)}/doc/${encodeURIComponent(data.id)}`);
        return;
      }
    } catch (e) {
      setSaveMdError("网络异常，请重试");
      console.error(e);
    } finally {
      setSaveMdLoading(false);
    }
  }, [userId, docId, topic, outline, referenceText, selectedKnowledgeDatasetIds, getCurrentBodyHtml, router]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (selected) setFiles(Array.from(selected));
  };

  const handleGenerateOutline = async (preserveOutline = false) => {
    if (!topic.trim()) return;
    setLoading(true);
    if (!preserveOutline) setOutline(null);
    setError(null);
    try {
      const formData = new FormData();
      formData.set("topic", topic);
      formData.set("coreContent", coreContent);
      formData.set("styleMode", styleMode);
      files.forEach((f) => formData.append("files", f));

      const res = await fetch("/api/outline", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "生成失败，请稍后重试");
        return;
      }
      if (data.outline) setOutline(data.outline);
      setReferenceText(typeof data.referenceText === "string" ? data.referenceText : "");
    } catch (e) {
      setError("网络或请求异常，请稍后重试");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fileLabel = files.length
    ? `已选择 ${files.length} 个文件`
    : "未选择任何文件";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f5f7fa]">
      {/* 顶部导航 */}
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4 shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-gray-800">
            AI 智能写作平台
          </h1>
          {userId && (
            <Link
              href={`/user/${encodeURIComponent(userId)}`}
              className="text-sm text-[#2563eb] hover:underline"
            >
              返回文档列表
            </Link>
          )}
        </div>
        <nav className="flex items-center gap-2 text-sm">
          {STEPS.map((s, i) => (
            <span key={s.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(s.id)}
                className={
                  step === s.id
                    ? "font-medium text-[#2563eb]"
                    : "text-gray-500 hover:text-gray-700"
                }
              >
                {s.label}
              </button>
              {i < STEPS.length - 1 && (
                <span className="text-gray-300">→</span>
              )}
            </span>
          ))}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden p-6">
        {/* 左侧：可滚动内容 + 底部固定按钮 */}
        <aside className="flex w-[420px] shrink-0 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
          {step === "body" || step === "optimize" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <h2 className="mb-4 text-sm font-medium text-gray-700">
                报告目录
              </h2>
              <ul className="space-y-2">
                {editableOutline.map((item, i) => (
                  <li
                    key={i}
                    className="rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2.5 text-sm text-gray-800"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : !outline ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <section className="mb-6">
                <h2 className="mb-2 text-sm font-medium text-gray-700">
                  数据来源
                </h2>
                <p className="text-sm leading-relaxed text-gray-600">
                  本系统基于本地化部署的 DeepSeek-32B
                  模型，结合能源行业数据库与知识库动态积累数据，用于生成专业报告内容。
                </p>
              </section>

              <section className="mb-5">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  报告主题 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={topic ?? ""}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="如:2025 年新能源发展形势分析报告"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                />
              </section>

              <section className="mb-5">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  核心内容 <span className="text-gray-400">(可选)</span>
                </label>
                <textarea
                  value={coreContent ?? ""}
                  onChange={(e) => setCoreContent(e.target.value)}
                  placeholder="补充政策背景、领导关注点"
                  rows={4}
                  className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                />
              </section>

              <section className="mb-6">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  重点引用资料 <span className="text-gray-400">(可选)</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileChange}
                  className="input-file-hidden"
                  accept=".txt,.doc,.docx"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-lg border border-[#2563eb] bg-white px-4 py-2 text-sm font-medium text-[#2563eb] hover:bg-blue-50"
                  >
                    选择文件
                  </button>
                  <span className="text-sm text-gray-500">{fileLabel}</span>
                </div>
                <p className="mt-1.5 text-xs text-gray-400">
                  上传后，AI 将优先引用资料内容
                </p>
              </section>

              <section className="mb-6">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  本对话使用的知识库 <span className="text-gray-400">(可选)</span>
                </label>
                {knowledgeDatasetOptions.length > 0 ? (
                  <>
                    <select
                      multiple
                      value={selectedKnowledgeDatasetIds}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, (o) => o.value);
                        setSelectedKnowledgeDatasetIds(selected);
                      }}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                      size={Math.min(4, knowledgeDatasetOptions.length)}
                    >
                      {knowledgeDatasetOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1.5 text-xs text-gray-400">
                      可多选，生成正文时从所选知识库检索；不选则本对话不使用知识库
                    </p>
                  </>
                ) : (
                  <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-500">
                    暂无可选知识库。请确认已配置 KNOWLEDGE_API_KEY、KNOWLEDGE_BASE_URL，且知识库服务可访问。
                  </p>
                )}
              </section>
              </div>
              <div className="shrink-0 border-t border-gray-100 p-6 pt-4">
                <button
                  type="button"
                  onClick={() => handleGenerateOutline()}
                  disabled={!topic.trim() || loading}
                  className="w-full rounded-lg bg-[#2563eb] py-3 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "正在生成…" : "生成大纲"}
                </button>
                {error && (
                  <p className="mt-3 text-sm text-red-600">{error}</p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
              <h2 className="mb-4 text-sm font-medium text-gray-700">
                AI生成目录 (可调整)
              </h2>
              <ul className="mb-4 space-y-2">
                {editableOutline.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm"
                  >
                    <input
                      type="text"
                      value={item ?? ""}
                      onChange={(e) => updateOutlineItem(i, e.target.value)}
                      className="min-w-0 flex-1 border-0 bg-transparent text-gray-800 focus:ring-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeOutlineItem(i)}
                      className="shrink-0 text-gray-400 hover:text-red-500"
                      title="删除"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mb-4 flex gap-4 text-sm">
                <button
                  type="button"
                  onClick={addOutlineItem}
                  className="text-[#2563eb] hover:underline"
                >
                  新增目录
                </button>
                <button
                  type="button"
                  onClick={handleRegenerateOutline}
                  disabled={loading}
                  className="text-[#2563eb] hover:underline disabled:opacity-50"
                >
                  重新生成
                </button>
              </div>

              <section className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  本对话使用的知识库
                </label>
                {knowledgeDatasetOptions.length > 0 ? (
                  <>
                    <select
                      multiple
                      value={selectedKnowledgeDatasetIds}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, (o) => o.value);
                        setSelectedKnowledgeDatasetIds(selected);
                      }}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                      size={Math.min(3, knowledgeDatasetOptions.length)}
                    >
                      {knowledgeDatasetOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.name}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-400">可多选；不选则本对话不使用知识库</p>
                  </>
                ) : (
                  <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                    暂无可选知识库
                  </p>
                )}
              </section>

              <section className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  字数要求
                </label>
                <input
                  type="text"
                  value={wordCount ?? ""}
                  onChange={(e) => setWordCount(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                />
              </section>

              <section className="mb-4">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  正文生成方式
                </label>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setBodyGenMode("full")}
                    className={`w-full rounded-lg border-2 px-3 py-2.5 text-left text-sm transition ${
                      bodyGenMode === "full"
                        ? "border-[#2563eb] bg-blue-50/50 text-gray-800"
                        : "border-gray-200 bg-gray-50/50 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <span className="font-medium">全文连贯</span>
                    <span className="mt-0.5 block text-xs text-gray-500">一气呵成，前后一致，推荐</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setBodyGenMode("sections")}
                    className={`w-full rounded-lg border-2 px-3 py-2.5 text-left text-sm transition ${
                      bodyGenMode === "sections"
                        ? "border-[#2563eb] bg-blue-50/50 text-gray-800"
                        : "border-gray-200 bg-gray-50/50 text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <span className="font-medium">分节并发生成</span>
                    <span className="mt-0.5 block text-xs text-gray-500">速度更快，章节相对独立</span>
                  </button>
                </div>
              </section>

              <section className="mb-6">
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  报告模板
                </label>
                <select
                  value={reportTemplate ?? ""}
                  onChange={(e) => setReportTemplate(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
                >
                  <option value="公告模板">公告模板</option>
                  <option value="报告模板">报告模板</option>
                </select>
              </section>
              </div>
              <div className="shrink-0 border-t border-gray-100 p-6 pt-4">
                <button
                  type="button"
                  onClick={handleConfirmOutline}
                  className="w-full rounded-lg bg-[#2563eb] py-3 text-sm font-medium text-white hover:bg-[#1d4ed8]"
                >
                  确认大纲，生成正文
                </button>
              </div>
            </>
          )}
        </aside>

        {/* 右侧内容区 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white p-8 shadow-sm">
          {exportSuccess ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-6 py-12">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-gray-800">报告导出成功</h2>
                <p className="text-sm text-gray-600">Word 文档已生成并下载</p>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
                <svg className="h-5 w-5 shrink-0 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>已遵守标准公文样式，可用于正式文档</span>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg bg-[#2563eb] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#1d4ed8]"
                onClick={() => {
                  setExportSuccess(false);
                  setStep("outline");
                  setOutline(null);
                  setTopic("");
                  setCoreContent("");
                  setFiles([]);
                  setReferenceText("");
                  setBodyContent("");
                  setContentHistoryState({ history: [], index: -1 });
                  setBodySections([]);
                  setBodyProgress(0);
                  setBodyCompleted(false);
                  setError(null);
                }}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                开始新写作
              </button>
            </div>
          ) : step === "outline" ? (
            <>
              <div className="flex flex-col items-center justify-center py-12">
                <div className="relative mb-4">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-50">
                    <svg
                      className="h-10 w-10 text-[#2563eb]"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                  <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-xs">
                    ✦
                  </span>
                </div>
                <h2 className="mb-2 text-xl font-semibold text-gray-800">
                  准备生成报告
                </h2>
                <p className="text-sm text-gray-500">
                  请在左侧完成信息填写后，生成报告内容。
                </p>
              </div>

              <div className="mt-8 grid grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setStyleMode("ai")}
                  className={`flex items-start gap-3 rounded-xl border-2 p-4 text-left transition ${
                    styleMode === "ai"
                      ? "border-[#2563eb] bg-blue-50/50"
                      : "border-gray-200 bg-gray-50/50 hover:border-gray-300"
                  }`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                    ✦
                  </span>
                  <div>
                    <div className="font-medium text-gray-800">
                      AI 智能生成
                    </div>
                    <div className="mt-0.5 text-sm text-gray-500">
                      基于大模型技术
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setStyleMode("standard")}
                  className={`flex items-start gap-3 rounded-xl border-2 p-4 text-left transition ${
                    styleMode === "standard"
                      ? "border-[#2563eb] bg-blue-50/50"
                      : "border-gray-200 bg-gray-50/50 hover:border-gray-300"
                  }`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-slate-600">
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                  </span>
                  <div>
                    <div className="font-medium text-gray-800">
                      标准公文样式
                    </div>
                    <div className="mt-0.5 text-sm text-gray-500">
                      符合规范要求
                    </div>
                  </div>
                </button>
              </div>
            </>
          ) : step === "body" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-4 shrink-0 flex items-center justify-between gap-4">
                <span className="text-sm text-gray-600">
                  生成进度: {bodyProgress}%
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleAbortBody}
                    disabled={!isBodyGenerating}
                    className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    终止生成
                  </button>
                  <button
                    type="button"
                    onClick={handleRegenerateBody}
                    disabled={isBodyGenerating}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    重新生成
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    历史版本
                  </button>
                  {userId && (
                    <button
                      type="button"
                      disabled={(!bodyContent && !(isBodyGenerating && bodySections.length)) || saveMdLoading}
                      className="rounded-lg border border-[#2563eb] bg-white px-3 py-1.5 text-sm font-medium text-[#2563eb] hover:bg-[#2563eb]/5 disabled:opacity-50"
                      onClick={saveDocument}
                    >
                      {saveMdLoading ? "保存中…" : "保存"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!bodyContent && !(isBodyGenerating && bodySections.length)}
                    className="rounded-lg bg-[#2563eb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#1d4ed8] disabled:opacity-50"
                    onClick={() => exportAsWord()}
                  >
                    导出 Word
                  </button>
                </div>
              </div>
              {saveMdError && (
                <p className="mt-2 text-sm text-red-600">{saveMdError}</p>
              )}
              <div
                ref={bodyContentScrollRef}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-gray-50/30 p-4"
              >
                <div className="markdown-body font-sans text-sm leading-relaxed text-gray-800 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-base [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-0.5 [&_strong]:font-semibold">
                  {(() => {
                    const rawText =
                      isBodyGenerating && bodySections.length
                        ? buildFullTextFromSections(bodySections)
                        : bodyContent;
                    const displayText = rawText ? ensureSectionHeadersAsH2(rawText) : "";
                    return displayText ? (
                      <ReactMarkdown>{displayText}</ReactMarkdown>
                    ) : (
                      <span className="text-gray-500">
                        {isBodyGenerating ? "正在生成正文…" : ""}
                      </span>
                    );
                  })()}
                </div>
              </div>
              {bodyCompleted && (
                <div className="mt-4 shrink-0 flex items-start gap-3 rounded-lg border border-green-200 bg-green-50/50 p-4">
                  <span className="text-green-600">✔</span>
                  <div>
                    <p className="font-medium text-gray-800">文章已撰写完成!</p>
                    <p className="mt-1 text-sm text-gray-600">
                      已按{styleMode === "standard" ? "标准公文" : "当前"}样式生成，可进入优化进一步调整。
                    </p>
                    <button
                      type="button"
                      onClick={handleEnterOptimize}
                      className="mt-3 rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white hover:bg-[#1d4ed8]"
                    >
                      进入内容优化
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-gray-100 pb-3">
                <span className="text-sm font-medium text-gray-700">
                  AI 辅助工具:
                </span>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
                  disabled={!!aiToolLoading}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAiTool("polish")}
                >
                  {aiToolLoading === "polish" ? "处理中..." : "润色"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
                  disabled={!!aiToolLoading}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAiTool("simplify")}
                >
                  {aiToolLoading === "simplify" ? "处理中..." : "精简"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:pointer-events-none"
                  disabled={!!aiToolLoading}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAiTool("expand")}
                >
                  {aiToolLoading === "expand" ? "处理中..." : "扩充"}
                </button>
                <span className="ml-auto text-xs text-amber-600">
                  ① AI 仅供参考，请自行审核修改
                </span>
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-gray-100 pb-2">
                <select
                  className="hidden rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700"
                  defaultValue="段落"
                  aria-hidden
                >
                  <option value="段落">段落</option>
                </select>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.bold ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="粗体"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("bold")}
                >
                  <span className="font-bold">B</span>
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.italic ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="斜体"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("italic")}
                >
                  <span className="italic">I</span>
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.underline ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="下划线"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("underline")}
                >
                  <span className="underline">U</span>
                </button>
                <div className="mx-1 w-px shrink-0 self-stretch bg-gray-200" />
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.justifyLeft ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="左对齐"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("justifyLeft")}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 5h16v2H4V5zM4 10h8v2H4V10zM4 15h16v2H4V15z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.justifyCenter ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="居中对齐"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("justifyCenter")}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 5h16v2H4V5zM8 10h8v2H8V10zM4 15h16v2H4V15z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.justifyRight ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="右对齐"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("justifyRight")}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 5h16v2H4V5zM12 10h8v2H12V10zM4 15h16v2H4V15z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-gray-100 ${toolbarActive.justifyFull ? "bg-blue-100 text-blue-700" : "text-gray-600"}`}
                  title="两端对齐"
                  onMouseDown={(e) => { e.preventDefault(); saveSelectionForFormat(); }}
                  onClick={() => execRichTextFormat("justifyFull")}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M4 5h16v2H4V5zM4 10h16v2H4V10zM4 15h16v2H4V15z" />
                  </svg>
                </button>
                <div className="mx-1 w-px shrink-0 self-stretch bg-gray-200" />
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:pointer-events-none"
                  title="撤销"
                  onClick={handleContentUndo}
                  disabled={contentHistoryState.index <= 0}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path strokeWidth={2} d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:opacity-50 disabled:pointer-events-none"
                  title="重做"
                  onClick={handleContentRedo}
                  disabled={contentHistoryState.index >= contentHistoryState.history.length - 1 || contentHistoryState.history.length === 0}
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <g transform="translate(24,0) scale(-1,1)">
                      <path strokeWidth={2} d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                    </g>
                  </svg>
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200 bg-gray-50/30">
                <div
                  ref={previewEditableRef}
                  contentEditable
                  suppressContentEditableWarning
                  onFocus={updateToolbarState}
                  onBlur={handlePreviewEditableBlur}
                  className="markdown-body p-4 font-sans text-sm leading-relaxed text-gray-800 outline-none [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-base [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-0.5 [&_strong]:font-semibold empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
                  data-placeholder="暂无内容，请先生成正文。"
                />
              </div>
              {saveMdError && (
                <p className="mt-2 text-sm text-red-600">{saveMdError}</p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                {userId && (
                  <button
                    type="button"
                    disabled={saveMdLoading}
                    className="rounded-lg border border-[#2563eb] bg-white px-4 py-2 text-sm font-medium text-[#2563eb] hover:bg-[#2563eb]/5 disabled:opacity-50"
                    onClick={saveDocument}
                  >
                    {saveMdLoading ? "保存中…" : "保存"}
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-medium text-white hover:bg-[#1d4ed8]"
                  onClick={() => exportAsWord()}
                >
                  导出 Word
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
