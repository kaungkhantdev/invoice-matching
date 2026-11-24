/** Node / undici codes for "couldn't reach the server": worth trying again later. */
const NETWORK_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "EPROTO",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "ENETRESET",
  "ENOTCONN",
  "ESHUTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
];

/**
 * Is this error, or the error that caused it, a network failure?
 * AWS login providers wrap the original error and copy its text into their message, so the text is checked too
 * (e.g. an SSO login refresh that fails with "getaddrinfo ENOTFOUND" while the Wi-Fi is down).
 */
export function isNetworkProblem(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === "string" && NETWORK_CODES.includes(e.code)) return true;
  if (typeof e.message === "string" && NETWORK_CODES.some((code) => (e.message as string).includes(code))) return true;
  return isNetworkProblem(e.cause, depth + 1);
}

/**
 * The AWS SDK's words for "found no login on this machine". Only used to pick the message: a failure to GET a
 * login is always tried again, because the same words also come from a login helper (credential_process such
 * as aws-vault or Granted) that is only offline for a moment.
 */
export const noLoginAtAll = (text: string) => /could not load credentials from any providers/i.test(text);
