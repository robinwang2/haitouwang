export interface ReviewView {
  id: string;
  status: string;
  recommendation: string;
  findings: Array<{ id: string; severity: string; status: string }>;
}

export interface ApprovalInput {
  expected_version: number;
  facts: unknown[];
  evaluated_at: string;
  goal_id?: string;
  review_id: string;
}

export class WorkflowApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowApiError';
  }
}

export class MaterialReviewApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  public getReview(reviewId: string): Promise<ReviewView> {
    return this.request(`/v1/reviews/${encodeURIComponent(reviewId)}`);
  }

  public resolveFinding(reviewId: string, findingId: string): Promise<ReviewView> {
    return this.request(
      `/v1/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/resolve`,
      { method: 'POST' },
    );
  }

  public approveMaterial<T>(materialId: string, input: ApprovalInput): Promise<T> {
    return this.request(`/v1/materials/${encodeURIComponent(materialId)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  public listAudit<T>(materialId: string): Promise<{ items: T[] }> {
    return this.request(`/v1/audit-events?resource_id=${encodeURIComponent(materialId)}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.accessToken}` },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = errorEnvelope(body);
      throw new WorkflowApiError(
        response.status,
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? 'Request failed.',
      );
    }
    return body as T;
  }
}

function errorEnvelope(value: unknown): { code?: string; message?: string } | undefined {
  if (value === null || typeof value !== 'object' || !('error' in value)) return undefined;
  const error = value.error;
  return error !== null && typeof error === 'object'
    ? (error as { code?: string; message?: string })
    : undefined;
}
