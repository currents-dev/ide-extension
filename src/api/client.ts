import type {
  AiContextPayload,
  ApiListResponse,
  ApiResponse,
  Instance,
  ListRunsOptions,
  Project,
  Run,
  RunFeedItem,
  TestExplorerOptions,
  TestExplorerResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.currents.dev/v1";

export class CurrentsApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Currents API ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async getProjects(
    opts: { limit?: number; fetchAll?: boolean } = {},
  ): Promise<ApiListResponse<Project>> {
    const limit = opts.limit ?? 50;
    if (!opts.fetchAll) {
      return this.request(`/projects?limit=${limit}`);
    }
    const all: Project[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("starting_after", cursor);
      const page = await this.request<ApiListResponse<Project>>(
        `/projects?${params}`,
      );
      all.push(...page.data);
      if (!page.has_more || page.data.length === 0) break;
      cursor = page.data[page.data.length - 1].cursor;
    }
    return { status: "OK", has_more: false, data: all };
  }

  async getProjectRuns(
    projectId: string,
    opts: ListRunsOptions = {},
  ): Promise<ApiListResponse<RunFeedItem>> {
    const params = new URLSearchParams();
    if (opts.limit) {
      params.set("limit", String(opts.limit));
    }
    if (opts.starting_after) {
      params.set("starting_after", opts.starting_after);
    }
    if (opts.branches?.length) {
      for (const b of opts.branches) {
        params.append("branches[]", b);
      }
    }
    if (opts.authors?.length) {
      for (const a of opts.authors) {
        params.append("authors[]", a);
      }
    }
    const qs = params.toString();
    return this.request(`/projects/${projectId}/runs${qs ? `?${qs}` : ""}`);
  }

  async getRun(runId: string): Promise<ApiResponse<Run>> {
    return this.request(`/runs/${runId}`);
  }

  async getInstance(instanceId: string): Promise<ApiResponse<Instance>> {
    return this.request(`/instances/${instanceId}`);
  }

  async getTestsExplorer(
    projectId: string,
    opts: TestExplorerOptions,
  ): Promise<TestExplorerResponse> {
    const params = new URLSearchParams();
    params.set("date_start", opts.date_start);
    params.set("date_end", opts.date_end);
    if (opts.page !== undefined) {
      params.set("page", String(opts.page));
    }
    if (opts.limit) {
      params.set("limit", String(opts.limit));
    }
    if (opts.order) {
      params.set("order", opts.order);
    }
    if (opts.dir) {
      params.set("dir", opts.dir);
    }
    if (opts.branches?.length) {
      for (const b of opts.branches) {
        params.append("branches[]", b);
      }
    }
    if (opts.tags?.length) {
      for (const t of opts.tags) {
        params.append("tags[]", t);
      }
    }
    if (opts.authors?.length) {
      for (const a of opts.authors) {
        params.append("authors[]", a);
      }
    }
    if (opts.spec) {
      params.set("spec", opts.spec);
    }
    if (opts.title) {
      params.set("title", opts.title);
    }
    const qs = params.toString();
    return this.request(`/tests/${projectId}?${qs}`);
  }

  async getAiContext(
    instanceId: string,
    testId: string,
    attempt?: number,
  ): Promise<AiContextPayload> {
    const params = new URLSearchParams({
      instance_id: instanceId,
      test_id: testId,
      format: "json",
    });
    if (attempt !== undefined) {
      params.set("attempt", String(attempt));
    }
    return this.request(`/ai-context?${params}`);
  }

  async getAiContextBySignature(
    projectId: string,
    signature: string,
  ): Promise<AiContextPayload> {
    const params = new URLSearchParams({
      project_id: projectId,
      signature,
      format: "json",
    });
    return this.request(`/ai-context?${params}`);
  }

  async fetchUrl(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status}: ${url}`);
    }
    return res.text();
  }
}
