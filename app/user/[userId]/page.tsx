"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type DocMeta = { id: string; title: string; updatedAt: string };

export default function UserDocsPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const [userId, setUserId] = useState<string>("");
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    params.then((p) => {
      if (!mounted) return;
      setUserId(p.userId);
      setLoading(true);
      setError(null);
      fetch(`/api/users/${encodeURIComponent(p.userId)}/docs`)
        .then((res) => res.json())
        .then((data) => {
          if (!mounted) return;
          if (data.error) {
            setError(data.error);
            setDocs([]);
          } else {
            setDocs(data.docs ?? []);
          }
        })
        .catch(() => {
          if (mounted) {
            setError("加载文档列表失败");
            setDocs([]);
          }
        })
        .finally(() => {
          if (mounted) setLoading(false);
        });
    });
    return () => {
      mounted = false;
    };
  }, [params]);

  const formatDate = (iso: string) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100/80">
      <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-6 lg:px-8">
          <h1 className="text-xl font-semibold tracking-tight text-slate-800">
            我的文档
          </h1>
          <span
            className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
            title="当前用户"
          >
            {userId || "—"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-500">
            {docs.length > 0 ? `共 ${docs.length} 篇文档` : "管理你的报告与文档"}
          </p>
          <Link
            href={userId ? `/user/${encodeURIComponent(userId)}/doc/new` : "#"}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-800 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 disabled:opacity-50"
          >
            <span aria-hidden className="text-base leading-none">＋</span>
            新建文档
          </Link>
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-slate-500">
              <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
              <p className="text-sm">加载中…</p>
            </div>
          )}
          {error && (
            <div className="border-b border-red-200/80 bg-red-50/80 px-6 py-4 text-red-700">
              <p className="text-sm font-medium">{error}</p>
            </div>
          )}
          {!loading && !error && docs.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-2xl text-slate-400">
                📄
              </div>
              <div>
                <p className="text-slate-600">暂无文档</p>
                <p className="mt-1 text-sm text-slate-500">
                  点击「新建文档」开始写作
                </p>
              </div>
              <Link
                href={userId ? `/user/${encodeURIComponent(userId)}/doc/new` : "#"}
                className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                新建文档
              </Link>
            </div>
          )}
          {!loading && !error && docs.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {docs.map((doc) => (
                <li key={doc.id}>
                  <Link
                    href={`/user/${encodeURIComponent(userId)}/doc/${encodeURIComponent(doc.id)}`}
                    className="group flex items-center gap-4 px-5 py-4 transition hover:bg-slate-50/80 active:bg-slate-100/80 sm:px-6"
                  >
                    <span className="min-w-0 flex-1 font-medium text-slate-800">
                      {doc.title || "未命名"}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400 tabular-nums">
                      {formatDate(doc.updatedAt)}
                    </span>
                    <span
                      className="shrink-0 text-slate-300 transition group-hover:text-slate-500"
                      aria-hidden
                    >
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
