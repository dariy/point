/**
 * Types for the tests that fake fetch and assert on the requests the code sends.
 */

import { mock } from './mock.ts';

/** One request the fake fetch saw. `body` is the parsed JSON body, if any. */
export interface RecordedRequest {
  url: string;
  method: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** What the fake fetch replies with. */
export interface FakeReply {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Choose a reply for a request. */
export type Responder = (url: string, opts: RequestInit) => FakeReply;

/** The arguments of fetch, with the request input as the URL string the code sends. */
export function requestOf(input: RequestInfo | URL, opts: RequestInit, method = opts.method): RecordedRequest {
  return {
    url: String(input),
    method,
    body: opts.body ? JSON.parse(String(opts.body)) : undefined,
  };
}

/** A JSON Response that holds only what api/client.ts reads. */
export function jsonResponse({ ok, status, body }: FakeReply): Response {
  return mock<Response>({ ok, status, headers: mock<Headers>({ get: () => 'application/json' }), json: async () => body });
}
