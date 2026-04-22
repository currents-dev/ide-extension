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
  title?: string | null;
  pr?: {
    id?: string | null;
    title?: string | null;
  } | null;
  commit: {
    sha: string;
    branch: string;
    authorName: string;
    authorEmail: string;
    message: string;
    remoteOrigin: string;
    ghaEventData?: {
      prTitle?: string;
      htmlUrl?: string;
      issueUrl?: string;
    };
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

export interface InstanceTrace {
  testId: string;
  traceId: string;
  testAttemptIndex: number;
  name: string;
  traceURL: string;
}

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
    playwrightTraces?: InstanceTrace[];
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

// --- Tests Explorer ---

export interface TestExplorerItem {
  title: string;
  signature: string;
  spec: string;
  metrics: {
    executions: number;
    failures: number;
    ignored: number;
    passes: number;
    flaky: number;
    flakinessRate: number;
    failureRate: number;
    avgDurationMs: number;
    flakinessVolume: number;
    failureVolume: number;
    durationVolume: number;
  };
  latestTag: string[] | null;
  lastSeen: string | null;
}

export interface TestExplorerResponse {
  status: "OK";
  data: {
    list: TestExplorerItem[];
    count: number;
    total: number;
    nextPage: number | false;
  };
}

export interface TestExplorerOptions {
  date_start: string;
  date_end: string;
  page?: number;
  limit?: number;
  order?: string;
  dir?: "asc" | "desc";
  branches?: string[];
  tags?: string[];
  authors?: string[];
  spec?: string;
  title?: string;
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

// --- AI Context ---

export interface AiContextError {
  message?: string | null;
  stack?: string | null;
  location?: {
    file: string;
    line: number;
    column: number;
  } | null;
  snippet?: string | null;
}

export interface AiContextStep {
  title: string;
  category?: string;
  duration: number;
  error?: AiContextError | null;
  steps: AiContextStep[];
}

export interface AiContextAsset {
  name: string;
  url: string;
}

export interface AiContextAttachment {
  name: string;
  filename: string;
  contentType: string;
  url: string;
}

export interface AiContextConsoleEntry {
  time: number;
  messageType: string;
  text: string;
  location: { url: string; lineNumber: number; columnNumber: number } | null;
}

export interface AiContextNetworkRequest {
  time: number;
  url: string;
  status: number;
  method: string;
}

export interface AiContextTraceErrorAnalysis {
  consoleEntries: AiContextConsoleEntry[];
  networkRequests: AiContextNetworkRequest[];
}

export interface AiContextFailureContext {
  failedStepIndex: number;
  stepBefore: AiContextStep | null;
  failedStep: AiContextStep;
  stepAfter: AiContextStep | null;
}

export interface AiContextOtherAttemptErrorSummary {
  message: string | null;
  location: { file: string; line: number; column: number } | null;
}

export interface AiContextOtherAttempt {
  attempt: number;
  status: string;
  sameError: boolean;
  error: AiContextOtherAttemptErrorSummary | null;
}

export interface AiContextPayload {
  spec: string;
  test: {
    title: string[];
    status: string;
    attempt: number;
    totalAttempts: number;
    duration: number;
  };
  error: AiContextError | null;
  otherAttempts: AiContextOtherAttempt[];
  errorContext: AiContextAsset | null;
  traceErrorAnalysis: AiContextTraceErrorAnalysis | null;
  failureContext: AiContextFailureContext | null;
  steps: AiContextStep[];
  stdout: string[];
  stderr: string[];
  assets: {
    traces: AiContextAsset[];
    screenshots: AiContextAsset[];
    videos: AiContextAsset[];
    attachments: AiContextAttachment[];
  };
  meta: {
    projectId: string;
    runId: string;
    instanceId: string;
    testId: string;
    signature: string;
    attempt: number;
  };
  environment: {
    framework: { type: string; version: string | null } | null;
    platform: {
      osName: string;
      osVersion: string;
      browserName: string;
      browserVersion: string;
    } | null;
    project: string | null;
  };
}
