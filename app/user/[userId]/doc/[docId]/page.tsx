"use client";

import { use, useEffect, useState } from "react";
import ReportForm from "@/app/components/ReportForm";

export type DocInitialData = {
  topic: string;
  outline: string[];
  body: string;
  title?: string;
  referenceText?: string;
  knowledgeDatasetIds?: string[];
};

export default function DocEditPage({
  params,
}: {
  params: Promise<{ userId: string; docId: string }>;
}) {
  const resolved = use(params);
  const { userId, docId } = resolved;
  const [initialData, setInitialData] = useState<DocInitialData | null | "loading">("loading");

  useEffect(() => {
    if (docId === "new") {
      setInitialData(null);
      return;
    }
    let mounted = true;
    fetch(`/api/users/${encodeURIComponent(userId)}/docs/${encodeURIComponent(docId)}`)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (!mounted) return;
        if (!data) {
          setInitialData(null);
          return;
        }
        setInitialData({
          topic: data.topic ?? "",
          outline: Array.isArray(data.outline) ? data.outline : [],
          body: data.body ?? "",
          title: data.title,
          referenceText: typeof data.referenceText === "string" ? data.referenceText : undefined,
          knowledgeDatasetIds: Array.isArray(data.knowledgeDatasetIds) ? data.knowledgeDatasetIds : undefined,
        });
      })
      .catch(() => {
        if (mounted) setInitialData(null);
      });
    return () => {
      mounted = false;
    };
  }, [userId, docId]);

  if (initialData === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-[#f5f7fa]">
        <p className="text-gray-500">加载文档…</p>
      </div>
    );
  }

  return (
    <ReportForm
      userId={userId}
      docId={docId === "new" ? undefined : docId}
      initialData={initialData ?? undefined}
    />
  );
}
