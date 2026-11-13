import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prepareCitationMarkdown } from "../src/core/citation-markdown";
import { Markdown } from "../src/Markdown";
import type { Project } from "../src/types";
const sources=[{id:"S1",page:1,text:"premise"},{id:"S2",page:1,text:"proof"}];
describe("actual Markdown citations", () => {
  it("excludes literal code, formulas, escaped text and unrelated links", () => {
    const input='`[S2]`\n\n```js\n"[S2]"\n```\n\n\\[S2] and $[S2]$ and [S1](https://example.com)';
    const result=prepareCitationMarkdown(input,sources);
    expect([...result.citedIds]).toEqual([]);
    expect(result.content).toBe(input);
    const html=renderToStaticMarkup(<Markdown message={{content:input,sources}} project={{assets:[]} as unknown as Project} onPage={()=>{}} />);
    expect(html).not.toContain('class="source-link"');
    expect(html).not.toContain('#source-S2');
  });
  it("counts only known citations and keeps explicit source links consistent", () => {
    const result=prepareCitationMarkdown('支持 [S2]，再次 [S2]，另见 [说明](#source-S1)。未知 [S8]。',sources);
    expect([...result.citedIds]).toEqual(["S2","S1"]);
    expect(result.content.match(/\[S2\]\(#source-S2\)/g)).toHaveLength(2);
    expect(result.content).toContain('未知 [S8]');
  });
});
