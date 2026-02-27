declare module "html-to-docx" {
  interface Options {
    font?: string;
    fontSize?: number;
    complexScriptFontSize?: number;
    table?: { row?: { cantSplit?: boolean } };
  }
  function HTMLtoDOCX(
    html: string,
    headerHtml: string | null,
    options?: Options
  ): Promise<Buffer>;
  export default HTMLtoDOCX;
}
