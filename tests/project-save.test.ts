import { describe, expect, it } from "vitest";
import { ProjectSaveQueue, type ProjectSnapshot } from "../src/core/project-save";
import type { Project } from "../src/types";
function snapshot(revision: number, id = "p"): ProjectSnapshot {
  return { revision, project: { document: { id }, notes: [{ draft: String(revision) }] } as Project };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
describe("coalesced project persistence", () => {
  it("joins identical saves and commits the newest version rather than every queued token", async () => {
    const first = deferred(), entered = deferred(), writes: string[] = [];
    let current = snapshot(1);
    const saver = new ProjectSaveQueue(async (project) => { writes.push(project.notes[0].draft); if (writes.length === 1) { entered.resolve(); await first.promise; } });
    const one = saver.flush(current, () => current); expect(saver.flush(current, () => current)).toBe(one);
    await entered.promise;
    current = snapshot(2); const two = saver.flush(current, () => current);
    current = snapshot(3); const three = saver.flush(current, () => current);
    first.resolve();
    const results = await Promise.all([one, two, three]);
    expect(writes).toEqual(["1", "3"]);
    expect(results.map((result) => result.revision)).toEqual([1, 3, 3]);
  });
  it("keeps the previous document's snapshot when the current reader changes", async () => {
    const hold = deferred(), entered = deferred(), writes: string[] = [];
    let current = snapshot(1, "a");
    const saver = new ProjectSaveQueue(async (project) => { writes.push(project.document.id); if (writes.length === 1) { entered.resolve(); await hold.promise; } });
    const a = saver.flush(current, () => current); await entered.promise;
    const old = snapshot(2, "a"); const a2 = saver.flush(old, () => current);
    current = snapshot(3, "b"); const b = saver.flush(current, () => current);
    hold.resolve(); await Promise.all([a, a2, b]);
    expect(writes).toEqual(["a", "a", "b"]);
  });
  it("retries failed saves without marking them complete or poisoning later writes", async () => {
    let attempts = 0; const value = snapshot(1);
    const saver = new ProjectSaveQueue(async () => { if (++attempts === 1) throw new Error("quota"); });
    await expect(saver.flush(value, () => value)).rejects.toThrow("quota");
    await expect(saver.flush(value, () => value)).resolves.toBe(value);
    expect(attempts).toBe(2);
  });
});
