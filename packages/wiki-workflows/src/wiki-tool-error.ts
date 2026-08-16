/** One-line reject for wiki_* tools — Pi's observer shows only the first error line. */
export function wikiToolRejected(tool: string, reason: string): Error {
  return new Error(`${oneLine(tool)} rejected: ${oneLine(reason)}`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
