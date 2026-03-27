// --- API response wrappers ---

export interface ApiListResponse<T> {
  status: "OK";
  has_more: boolean;
  data: T[];
}

export interface ApiResponse<T> {
  status: "OK";
  data: T;
}

// --- Projects ---

export interface Project {
  projectId: string;
  name: string;
  createdAt: string;
  cursor?: string;
}

// --- Runs ---

export interface RunFeedItem {
  runId: string;
  projectId: string;
  createdAt: string;
  durationMs: number | null;
  tags: string[];
  previousRunId: string | null;
  cursor: string;
  timeout: { isTimeout: boolean; timeoutValueMs: number | null };
  cancellation: {
    cancelledAt: string;
    cancelledBy: string;
    reason: string;
  } | null;
  groups: RunGroup[];
  meta: RunMeta;
  completionState: string;
  status: string;
}

export interface RunGroup {
  groupId: string;
  platform: {
    osName: string;
    osVersion: string;
    browserName: string;
    browserVersion: string;
  };
  tests: {
    overall: number;
    passes: number;
    failures: number;
    pending: number;
    skipped: number;
    flaky: number;
  };
}

export interface RunMeta {
  ciBuildId: string;
  commit: {
    sha: string;
    branch: string;
    authorName: string;
    authorEmail: string;
    message: string;
    remoteOrigin: string;
  };
  framework: {
    type: string;
    version: string;
  };
}

// --- Run (full detail, from GET /runs/{runId}) ---

export interface Run extends RunFeedItem {
  specs: RunSpec[];
}

export interface RunSpec {
  spec: string;
  groupId: string;
  instanceId: string;
  claimedAt: string;
  completedAt: string | null;
  machineId: string;
  tags: string[];
  results: {
    stats: {
      tests: number;
      passes: number;
      failures: number;
      pending: number;
      skipped: number;
      flaky: number;
      wallClockDuration: number;
    };
    exception: string | null;
    flaky: number;
  } | null;
}

// --- Instances ---

export interface Instance {
  instanceId: string;
  runId: string;
  groupId: string;
  spec: string;
  machineId: string;
  claimedAt: string;
  completedAt: string | null;
  results: {
    stats: {
      tests: number;
      passes: number;
      failures: number;
      pending: number;
      skipped: number;
    };
    exception: string | null;
    flaky: number;
    tests: InstanceTest[];
  } | null;
  testResults?: Record<string, InstanceTestResult>;
}

export interface InstanceTestResult {
  state: string;
  isFlaky: boolean;
  displayError: string | null;
  duration: number;
  attempts: TestAttempt[];
  [key: string]: unknown;
}

export interface InstanceTest {
  _s: "passed" | "failed" | "pending" | "skipped" | null;
  _d: boolean;
  _f: boolean;
  groupId: string;
  testId: string;
  spec: string;
  title: string[];
  originalTitle: string[];
  startTime: string;
  endTime: string;
  duration: number;
  displayError?: string | null;
  attempts?: TestAttempt[];
  [key: string]: unknown;
}

export interface TestAttempt {
  attemptId?: string;
  state?: string;
  wallClockStartedAt?: string;
  wallClockDuration?: number;
  error?: {
    message: string;
    stack: string;
  } | null;
}

// --- Filters ---

export interface RunFilters {
  branches?: string[];
  authors?: string[];
}

export interface ListRunsOptions extends RunFilters {
  limit?: number;
  starting_after?: string;
}
