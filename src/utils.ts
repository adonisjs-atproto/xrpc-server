/*
|--------------------------------------------------------------------------
| Web Fetch ↔ Adonis HTTP conversion utilities
|--------------------------------------------------------------------------
|
| Bridge between Adonis's HttpRequest/HttpResponse (wrapping Node's
| IncomingMessage/ServerResponse) and the Web Fetch Request/Response
| shapes that atcute's xrpc-server speaks.
|
| Same approach as fedify-dev/adonisjs's middleware: stream bodies in
| both directions via Readable.toWeb / Readable.fromWeb to avoid
| buffering large payloads.
*/

import { Readable } from 'node:stream'
import type {
  HttpRequest as AdonisHttpRequest,
  HttpResponse as AdonisHttpResponse,
} from '@adonisjs/core/http'

/**
 * Converts an Adonis HttpRequest into a Web Fetch Request.
 *
 * @param req - The Adonis request to convert.
 * @param baseUrl - Optional base URL used to resolve req.completeUrl(true)
 *   when the request lacks a Host header (e.g. tests using
 *   HttpContextFactory's default request). Real traffic supplies a Host
 *   header so this argument is unnecessary in production.
 */
export function adonisRequestToWebRequest(req: AdonisHttpRequest, baseUrl?: string | URL): Request {
  const urlString = req.completeUrl(true)
  const url = baseUrl ? new URL(urlString, baseUrl) : new URL(urlString)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers())) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else if (typeof value === 'string') {
      headers.append(key, value)
    }
  }

  const method = req.method() ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'

  return new Request(url, {
    method,
    headers,
    // duplex: 'half' is required by the Fetch spec when streaming a
    // ReadableStream body. Cast to RequestInit because TS lib types lag
    // behind the runtime support.
    ...(hasBody && { duplex: 'half', body: Readable.toWeb(req.request) }),
  } as RequestInit)
}

/**
 * Writes a Web Fetch Response back into an Adonis HttpResponse: copies
 * status + headers, then streams the body (if any) via
 * res.stream(Readable.fromWeb(body)).
 */
export function writeWebResponseToAdonisResponse(
  response: Response,
  res: AdonisHttpResponse
): void {
  res.status(response.status)
  response.headers.forEach((value, key) => {
    res.header(key, value)
  })
  if (response.body !== null) {
    res.stream(Readable.fromWeb(response.body))
  }
}
