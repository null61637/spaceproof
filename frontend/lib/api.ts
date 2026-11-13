import { errorMessage, type Certificate } from "./certificates";
import { backendUrl } from "./config";

// Server-side client for the NestJS certificates API (reads only). Files are
// sent by the browser itself: see lib/upload.ts.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${backendUrl}/api${path}`);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(body, res.status));
  }
  return body as T;
}

export function getCertificates(): Promise<Certificate[]> {
  return request("/certificates");
}

export function getCertificate(id: string): Promise<Certificate> {
  return request(`/certificates/${encodeURIComponent(id)}`);
}
