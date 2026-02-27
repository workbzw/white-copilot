declare module "html-to-docx" {
  interface Options {
    font?: string;
    table?: { row?: { cantSplit?: boolean } };
  }
  function HTMLtoDOCX(
    html: string,
    headerHtml: string | null,
    options?: Options
  ): Promise<Buffer>;
  export default HTMLtoDOCX;
}
