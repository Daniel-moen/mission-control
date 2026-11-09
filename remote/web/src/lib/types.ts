// Wire shapes the relay forwards from the Mac (RemoteBridge.swift /
// MiaManager.swift). Every field is optional on purpose: an older Mac app
// sends less, and the panel must degrade instead of crashing.

export interface Todo {
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
}

export interface Agent {
  id: string;
  name?: string;
  folder?: string;
  dir?: string;
  prompt?: string;
  status?: 'active' | 'idle' | 'done' | string;
  statusLabel?: string;
  activity?: string;
  isManager?: boolean;
  isMia?: boolean;
  controllable?: boolean;
  cost?: number;
  turns?: number;
  tokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  uptime?: string;
  lastActive?: string;
  todos?: Todo[];
  screen?: string;
  pid?: number;
  cpu?: number;
  mem?: number;
  branch?: string;
  alive?: boolean;
  fleetId?: string;
  model?: string;
}

export interface Summary {
  active?: number;
  idle?: number;
  done?: number;
  totalCost?: number;
  totalTokens?: number;
  tokensPerSec?: number;
}

export interface SystemInfo {
  cpu: number;
  cores?: number;
  memUsedMB?: number;
  memTotalMB?: number;
}

export interface DocMeta {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  subject?: string;
  tags?: string[];
  dir?: string;
  folder?: string;
  preview?: string;
  words?: number;
  created?: number;
  updatedAt?: number;
}

export interface DocBody {
  content: string;
  title: string;
  kind: string;
  status: string;
  updatedAt: number;
}

export interface MiaMessage {
  id: string;
  at?: string;
  from?: 'daniel' | 'mia' | 'system' | string;
  kind?: 'chat' | 'question' | 'answer' | 'event' | string;
  text?: string;
  options?: string[];
  taskId?: string | null;
  questionId?: string;
}

export interface MiaQuestion {
  questionId: string;
  taskId?: string | null;
  text?: string;
  options?: string[];
  askedAt?: string;
}

export interface TaskQuestion {
  id: string;
  text?: string;
  options?: string[];
  askedAt?: string;
  answer?: string | null;
}

export interface MiaTask {
  id: string;
  title?: string;
  detail?: string;
  dir?: string | null;
  status?: 'queued' | 'asking' | 'running' | 'checking' | 'done' | 'failed' | 'cancelled' | string;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
  questions?: TaskQuestion[];
  executor?: {
    dispatchedAt?: string;
    headless?: boolean;
    jobId?: number;
    sessionId?: string;
    model?: string;
    finishedAt?: string | null;
    attempt?: number;
    turn?: number;
    pid?: number;
  } | null;
  log?: { at?: string; text?: string }[];
  result?: unknown;
}

// mia-core's job table (~/.mission-control/mia/jobs.json, MiaCore.jobsSnapshot).
export interface Job {
  id: number;
  taskId?: string | null;
  beat?: string | null;
  kind?: string | null;
  model?: string;
  status?: 'queued' | 'running' | 'waiting' | 'finished' | 'failed' | 'cancelled' | string;
  waitReason?: string | null;
  sessionId?: string;
  attempts?: number;
  turn?: number;
  costUsd?: number;
  outputTokens?: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  tail?: string[];
}

export interface Jobs {
  online?: boolean;
  cap?: number;
  headless?: boolean;
  opusTokensToday?: number;
  budget?: { level?: number; detail?: string; paused?: boolean; pauseAt?: number };
  jobs: Job[];
  at?: string;
}

export interface Mia {
  enabled: boolean;
  online: boolean;
  sessionId: string;
  model: string;
  runningModel: string;
  restarts: number;
  readUpTo: string;
  messages: MiaMessage[];
  tasks: MiaTask[];
  pendingQuestions: MiaQuestion[];
  oldQuestions: MiaQuestion[];
  closedQuestions: Record<string, string>;
  questionMaxAgeHours: number | null;
  schedule: unknown;
  pushKey: string;
  jobs: Jobs | null;
}

export interface UsageWindow {
  key: string;
  label?: string;
  pct?: number;
  resetsAt?: string;
  severity?: string;
  active?: boolean;
}

export interface Usage {
  plan?: string;
  at?: string;
  stale?: boolean;
  windows?: UsageWindow[];
}

export interface Model {
  flag: string;
  label?: string;
  short?: string;
  blurb?: string;
}
