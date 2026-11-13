import { describe, expect, it } from "vitest";
import { blankTextTarget, type SelectionBox } from "../src/core/text-selection-layout";

const run = (id: string, left: number, top: number, right: number, bottom: number) => ({ id, left, top, right, bottom });
const first = [run("g",500,155,530,171),run("line1-end",540,155,750,171)];
const second = [run("line2",518,178,765,198)];
const third = [run("conclusion",417,213,470,224),run("QED",855,213,864,224)];

describe("blank PDF selection targets", () => {
  it("clamps a rightward overrun to the current line and advances through blank space to the next text", () => {
    expect(blankTextTarget([first,second,third],{x:920,y:164},0)).toBe(first[1]);
    expect(blankTextTarget([first,second,third],{x:508,y:205},1)).toBe(third[0]);
    expect(blankTextTarget([first,second,third],{x:508,y:180},1)).toBe(second[0]);
  });
  it("uses travel only in interline gaps, supports reverse drag and nearest-line neutral motion", () => {
    const lines = [first,second,third];
    expect(blankTextTarget(lines,{x:508,y:205},-1)).toBe(second[0]);
    expect(blankTextTarget(lines,{x:508,y:205},0)).toBe(second[0]);
    expect(blankTextTarget(lines,{x:508,y:210},0)).toBe(third[0]);
    expect(blankTextTarget(lines,{x:920,y:164},1)).toBe(first[1]);
    expect(blankTextTarget(lines,{x:920,y:164},-1)).toBe(first[1]);
  });
  it("clamps before the first and after the final visual line, regardless of DOM order", () => {
    const lines = [third,first,second];
    for (const travel of [-1,0,1] as const) {
      expect(blankTextTarget(lines,{x:508,y:20},travel)).toBe(first[0]);
      expect(blankTextTarget(lines,{x:508,y:400},travel)).toBe(third[0]);
    }
    expect(blankTextTarget(lines,{x:508,y:205},1)).toBe(third[0]);
  });
  it("leaves any actual text hit, including a different line or an exact box edge, native", () => {
    expect(blankTextTarget([first,second,third],{x:530,y:164},1)).toBeUndefined();
    expect(blankTextTarget([first,second,third],{x:600,y:188},-1)).toBeUndefined();
    expect(blankTextTarget([first,second,third],{x:859,y:219},0)).toBeUndefined();
  });
  it("handles disjoint columns by visual block order and closest inline run", () => {
    const left = run("left",30,100,150,120), right = run("right",350,100,500,120), below = run("below",20,160,150,180);
    expect(blankTextTarget([[below],[right,left]],{x:300,y:110},0)).toBe(right);
    expect(blankTextTarget([[below],[right,left]],{x:180,y:110},0)).toBe(left);
    expect(blankTextTarget([[below],[right,left]],{x:300,y:140},1)).toBe(below);
  });
  it("resolves overlapping formula rows by nearest block center, rather than first DOM group", () => {
    const lower = run("lower",30,110,100,130), upper = run("upper",30,100,100,120);
    expect(blankTextTarget([[lower],[upper]],{x:200,y:112},0)).toBe(upper);
    expect(blankTextTarget([[upper],[lower]],{x:200,y:118},0)).toBe(lower);
  });
  it("swaps block and inline axes for rotated text", () => {
    const rotate = (box: SelectionBox) => ({ left: box.top, top: box.left, right: box.bottom, bottom: box.right });
    const lines = [first,second,third].map(line => line.map(box => ({...rotate(box), id:box.id})));
    expect(blankTextTarget(lines,{x:164,y:920},0,true)).toBe(lines[0][1]);
    expect(blankTextTarget(lines,{x:205,y:508},1,true)).toBe(lines[2][0]);
    expect(blankTextTarget(lines,{x:205,y:508},-1,true)).toBe(lines[1][0]);
    expect(blankTextTarget(lines,{x:188,y:600},0,true)).toBeUndefined();
  });
  it("ignores empty/invalid groups and never fabricates a target", () => {
    expect(blankTextTarget([], {x:0,y:0}, 0)).toBeUndefined();
    expect(blankTextTarget([[],[run("invalid",NaN,0,10,10)]], {x:0,y:0}, 0)).toBeUndefined();
    expect(blankTextTarget([first], {x:NaN,y:0}, 0)).toBeUndefined();
  });
});
