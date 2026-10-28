// Opens the "Reportar un problema" sheet from anywhere in the app.
export interface ReportProblemRequest {
  /** Text placed in the description box, e.g. the error the user just saw */
  prefill?: string;
}

let current: ReportProblemRequest | null = null;
const listeners = new Set<() => void>();

export function openReportProblem(request: ReportProblemRequest = {}): void {
  current = request;
  listeners.forEach((l) => l());
}

export function closeReportProblem(): void {
  current = null;
  listeners.forEach((l) => l());
}

export function getReportProblemRequest(): ReportProblemRequest | null {
  return current;
}

export function subscribeReportProblem(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
