import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 智能写作平台",
  description: "基于大模型与能源行业知识库的专业报告生成",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
