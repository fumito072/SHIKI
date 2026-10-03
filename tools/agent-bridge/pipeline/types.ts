import type { ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';

export type AgentId = 'claude' | 'codex';
export type Mode = 'create' | 'feedback';

export interface AgentEvent {
  type: 'status' | 'text' | 'tool' | 'error' | 'done' | 'item';
  text: string;
  at: number;
}

export interface Job {
  id: string;
  agent: AgentId;
  model: string;
  effort: string;
  mode: Mode;
  workId: string | null;
  message: string;
  /** Create mode: start from a generated key visual (Codex image generation). */
  keyVisual: boolean;
  /** Automatic repair round sent by the Studio (0 = the user's own request). */
  attempt: number;
  state: 'running' | 'done' | 'error' | 'cancelled';
  createdWorkId?: string;
  events: AgentEvent[];
  listeners: Set<ServerResponse>;
  procs: Set<ChildProcess>;
  abort: AbortController;
  projectId?: string;
  kind?: 'round' | 'build';
  started: number;
  finished?: number;
}

export type Stage = 'look' | 'motion' | 'build' | 'done';
export type Engine = 'gpt-image' | 'pinterest-lora';
export interface Item {
  id: string; file: string | null; engine: Engine; prompt: string; title: string;
  motion?: string; status: 'queued' | 'running' | 'done' | 'error'; error?: string;
  rating: -1 | 0 | 1; note: string;
}
export interface Director { agent: AgentId; model: string; effort: string }
export interface Round {
  n: number; stage: 'look' | 'motion'; feedback: string;
  director: Director & { notes: string }; items: Item[]; at: number;
}
export interface Project {
  id: string; title: string; brief: string; refs: string[]; stage: Stage; rounds: Round[];
  keyVisual: string | null; studies: string[]; workId: string | null; created: number; updated: number;
}
