// Base URL of the NestJS backend, used by the /api rewrite and by server-side fetches.
export const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3001";
