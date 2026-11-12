import type { Project } from "../types";
export interface ProjectSnapshot { project: Project; revision: number }
/** Serialize writes, join identical requests, and replace queued obsolete versions with the latest snapshot. */
export class ProjectSaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<ProjectSnapshot>>();
  private completed = new Map<string, number>();
  constructor(private write: (project: Project) => Promise<void>) {}
  flush(snapshot: ProjectSnapshot, latest: () => ProjectSnapshot | undefined): Promise<ProjectSnapshot> {
    const id = snapshot.project.document.id, key = `${id}:${snapshot.revision}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.tail.catch(() => {}).then(async () => {
      const current = latest();
      const target = current?.project.document.id === id && current.revision >= snapshot.revision ? current : snapshot;
      if ((this.completed.get(id) ?? -1) < target.revision) {
        await this.write(target.project);
        this.completed.set(id, target.revision);
      }
      return target;
    });
    // The barrier must resolve to void so it cannot retain the last large project.
    this.tail = result.then(() => undefined, () => undefined); this.pending.set(key, result);
    void result.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key); }).catch(() => {});
    return result;
  }
}
