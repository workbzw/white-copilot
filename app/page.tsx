import ReportForm from "./components/ReportForm";

/** 首页使用默认用户，以便显示保存按钮并支持保存到「我的文档」 */
const DEFAULT_USER_ID = "default";

export default function Home() {
  return <ReportForm userId={DEFAULT_USER_ID} />;
}
