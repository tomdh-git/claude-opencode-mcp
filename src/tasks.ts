import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "./config.js";

export type TaskStatus = "created" | "running" | "completed" | "failed" | "interrupted";

export type Task = {
  taskId: string;
  directory: string;
  instructions: string;
  agent?: string;
  model?: string;
  status: TaskStatus;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  result?: string;
  blockingReason?: string;
  lastEvents?: string[];
};

type TaskInput = Omit<Task, "taskId" | "createdAt" | "updatedAt">;

function now(): number {
  return Date.now();
}

function emptyTask(directory: string, instructions: string, agent?: string, model?: string): TaskInput {
  return { directory, instructions, agent, model, status: "created" };
}

/** File-backed task registry for delegated OpenCode tasks. Atomic writes via temp file + rename. */
export class TaskRegistry {
  constructor(private filePath: string = PATHS.tasksRegistryPath) {}

  async load(): Promise<Task[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as Task[];
    } catch {
      return [];
    }
  }

  async save(tasks: Task[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  async create(input: TaskInput): Promise<Task> {
    const tasks = await this.load();
    const taskId = randomUUID();
    const task: Task = { ...input, taskId, status: "created", createdAt: now(), updatedAt: now() };
    tasks.push(task);
    await this.save(tasks);
    return task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    const tasks = await this.load();
    return tasks.find((t) => t.taskId === taskId);
  }

  async update(taskId: string, patch: Partial<Task>): Promise<Task | undefined> {
    const tasks = await this.load();
    const index = tasks.findIndex((t) => t.taskId === taskId);
    if (index === -1) return undefined;
    const next = { ...tasks[index], ...patch, updatedAt: now() } as Task;
    tasks[index] = next;
    await this.save(tasks);
    return next;
  }

  async list(): Promise<Task[]> {
    return this.load();
  }

  async remove(taskId: string): Promise<boolean> {
    const tasks = await this.load();
    const before = tasks.length;
    const next = tasks.filter((t) => t.taskId !== taskId);
    if (next.length === before) return false;
    await this.save(next);
    return true;
  }
}

export const taskRegistry = new TaskRegistry();
