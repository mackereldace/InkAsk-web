import Dexie, { type Table } from 'dexie';
import type { InkDocument, Project } from '../types';

class InkAskDatabase extends Dexie {
  projects!: Table<Project, string>;

  constructor() {
    super('inkask');
    this.version(1).stores({
      projects: 'document.id, document.updatedAt',
    });
  }
}

let database: InkAskDatabase | undefined;

function db(): InkAskDatabase {
  database ??= new InkAskDatabase();
  return database;
}

function cloneProject(project: Project): Project {
  return structuredClone(project);
}

function normalizeLoaded(project: Project): Project {
  const copy = cloneProject(project);
  for (const note of copy.notes) {
    for (const message of note.messages) {
      if (message.status === 'streaming') message.status = 'stopped';
    }
  }
  return copy;
}

export async function saveProject(project: Project): Promise<void> {
  const value = cloneProject(project);
  await db().projects.put(value);
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const project = await db().projects.get(id);
  return project ? normalizeLoaded(project) : undefined;
}

export async function listDocuments(): Promise<InkDocument[]> {
  const projects = await db().projects.toArray();
  return projects
    .map((project) => structuredClone(project.document))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await db().projects.delete(id);
}
