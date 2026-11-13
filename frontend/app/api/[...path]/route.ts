import { backendUrl } from "@/lib/config";

// Forwards /api/* to the NestJS backend, so the browser sees a single origin
// (no CORS).
//
// A Route Handler and not a `rewrites()` entry: the rewrite proxy keeps a copy
// of every request body in memory and cuts it at 10 MB, which breaks file
// uploads and would hold the file. Here the body goes on as a stream: nothing
// is buffered or stored on the way.

// Hop-by-hop headers describe one connection and are never forwarded.
// `fetch` decodes the response body, so its encoding and length no longer apply.
const NOT_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const NOT_RETURNED = new Set([
  ...NOT_FORWARDED,
  "content-encoding",
  "content-length",
]);

function copyHeaders(source: Headers, skip: Set<string>): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!skip.has(name)) headers.append(name, value);
  });
  return headers;
}

async function forward(request: Request): Promise<Response> {
  const { pathname, search } = new URL(request.url);
  let upstream: Response;
  try {
    upstream = await fetch(`${backendUrl}${pathname}${search}`, {
      method: request.method,
      headers: copyHeaders(request.headers, NOT_FORWARDED),
      body: request.body,
      // Required to send a stream; not in TypeScript's RequestInit yet.
      ...({ duplex: "half" } as RequestInit),
      // A browser that goes away cancels the upload to the backend too.
      signal: request.signal,
      // Both are needed to stream: with any other combination `fetch` keeps
      // a second copy of the body in memory, to resend it after a redirect
      // or an authentication challenge (Fetch standard, "HTTP-network-or-cache
      // fetch"). The backend never redirects.
      redirect: "error",
      window: null,
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { statusCode: 502, message: "Backend unavailable", error: "Bad Gateway" },
      { status: 502 },
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyHeaders(upstream.headers, NOT_RETURNED),
  });
}

// The whole API surface: reads and the two kinds of write (JSON and files).
export { forward as GET, forward as POST };
