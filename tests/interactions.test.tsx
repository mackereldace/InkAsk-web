import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { floatingPosition } from "../src/core/floating";
import { sourceAnchor } from "../src/core/source-location";
import { Markdown } from "../src/Markdown";
import { exportProject, importProject } from "../src/core/archive";
import type { PageText, Project } from "../src/types";
const page: PageText = { page: 1, text: "a derivative measures rate of change", source: "native", status: "ready", width: 600, height: 800,
  words: [{text:"a derivative ",rect:[10,100,100,120]}, {text:"measures rate ",rect:[100,100,200,120]}, {text:"of change",rect:[10,80,100,100]}] };
describe("selection and citation interactions", () => {
  it("places the question below a selection, above when occluded, and within narrow bounds", () => {
    const boundary = {left:0,top:40,right:380,bottom:740};
    expect(floatingPosition({left:50,top:100,right:150,bottom:130},{width:360,height:220},boundary)).toMatchObject({side:"below",left:12,top:140});
    const above = floatingPosition({left:330,top:650,right:375,bottom:680},{width:360,height:220},boundary);
    expect(above).toMatchObject({side:"above",left:12,top:420,width:360});
    expect(floatingPosition({left:290,top:100,right:315,bottom:120},{width:360,height:220},{...boundary,right:316}).width).toBe(300);
  });
  it("matches cited words across whitespace and retains explicit PDF anchors", () => {
    expect(sourceAnchor({id:"S2",page:1,text:"measures\nrate of change"},page)?.rects).toEqual([page.words[1].rect,page.words[2].rect]);
    expect(sourceAnchor({id:"S1",page:1,text:"not in extraction",rects:[[3,4,5,6]]},page)?.rects).toEqual([[3,4,5,6]]);
    expect(sourceAnchor({id:"S3",page:1,text:"unrelated passage"},page)).toBeUndefined();
    expect(sourceAnchor({id:"S1",page:1,text:"选中原文：a derivative\n\n当前页附近：a derivative measures rate of change"},page)?.rects).toEqual(page.words.map((word) => word.rect));
  });
  it("renders citations as preview buttons without a navigation href", () => {
    const project = { assets: [] } as unknown as Project;
    const html = renderToStaticMarkup(<Markdown message={{content:"依据原文 [S1]。",sources:[{id:"S1",page:1,text:"source"}]}} project={project} onPage={()=>{}} />);
    expect(html).toContain('aria-label="原文引用 S1，第 1 页"');
    expect(html).not.toContain('href="#source-');
    expect(html).not.toContain('title="source"');
  });
  it("backs up source coordinates and reading direction without requiring them in old archives", async () => {
    const project: Project = {version:1,document:{id:"p",name:"p.pdf",fingerprint:"p",pdf:new Blob(["%PDF-1.4 test"]),pageCount:1,createdAt:1,updatedAt:1},pages:[page],assets:[],templates:[],view:{page:1,scale:1,rotation:0,direction:"horizontal"},notes:[{id:"n",title:"n",anchor:{page:1,quote:"a",rects:[[0,0,1,1]]},inheritedHistory:[],collapsed:false,task:"explain",templateId:"t",draft:"",draftAssetIds:[],createdAt:1,messages:[{id:"a",role:"assistant",content:"[S1]",assetIds:[],status:"complete",createdAt:1,sources:[{id:"S1",page:1,text:"a",rects:[[2,3,4,5]]}]}]}]};
    project.templates=[{id:"t",name:"explain",task:"explain",body:"test",version:1}];
    const restored=await importProject(await exportProject(project));
    expect(restored.view.direction).toBe("horizontal");
    expect(restored.notes[0].messages[0].sources?.[0].rects).toEqual([[2,3,4,5]]);
  });
});
