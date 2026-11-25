import { config } from "../../../config.js";
import { isNetworkProblem, noLoginAtAll, RetryableError } from "../errors.js";

/** The page itself is the problem: the other pages and the AI still read the file. */
const BAD_PAGE = new Set([
  "UnsupportedDocumentException",
  "BadDocumentException",
  "DocumentTooLargeException",
  "InvalidParameterException",
]);
/** Textract busy or slow to answer: worth trying again later. */
const TEMPORARY = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "InternalServerError",
  "ServiceUnavailableException",
  "TimeoutError",
  "RequestTimeout",
]);
/** Getting the login failed (on this machine, before AWS was asked). */
const GETTING_LOGIN = new Set(["CredentialsProviderError", "TokenProviderError"]);
/** AWS itself rejected the login. */
const LOGIN_REJECTED = new Set(["UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException"]);

/**
 * Sort a Textract error into what to do:
 *   a page problem  → returned as text: the AI still reads the file, check 0 gets a note
 *   busy / network  → RetryableError: the queue tries the invoice again later
 *   login / access  → Error: the invoice goes to review with the fix in plain words
 */
export function pageProblemOrThrow(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (BAD_PAGE.has(name)) return badPageProblem(name);
  // Network down, even while refreshing an SSO login: temporary. (Checked before the login errors on purpose.)
  if (isBusyOrUnreachable(error, name)) {
    const what = name || code || "error";
    throw new RetryableError(`Textract (${config.textract.region}) busy or unreachable: ${what}: ${message}`);
  }
  throwIfLoginProblem(name, message);
  throw new Error(`Textract error ${name || String(code ?? "")}: ${message}`);
}

function badPageProblem(name: string): string {
  return name === "DocumentTooLargeException" ? "too large for Textract" : `Textract couldn't read it (${name})`;
}

/** Throttled, timed out, a 5xx answer or no network: worth trying again later. */
function isBusyOrUnreachable(error: unknown, name: string): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode ?? 0;
  const markedRetryable = Boolean((error as { $retryable?: unknown } | null)?.$retryable);
  return TEMPORARY.has(name) || isNetworkProblem(error) || markedRetryable || status >= 500;
}

/** Login and access errors, each with what to do about it. Returns when it's none of them. */
function throwIfLoginProblem(name: string, message: string): void {
  // Getting the login failed: tried again (it may only be offline), then Review with what to do.
  if (GETTING_LOGIN.has(name) && noLoginAtAll(message)) {
    throw new RetryableError(
      `Textract: no AWS login found on this machine (set the AWS keys in .env, or AWS_PROFILE): ${message}`,
    );
  }
  if (GETTING_LOGIN.has(name)) {
    throw new RetryableError(
      `Textract: couldn't get the AWS login (network down, or the SSO session ended: run "aws sso login"): ${message}`,
    );
  }
  if (LOGIN_REJECTED.has(name)) {
    throw new Error(`Textract: AWS rejected the login (wrong or expired keys?): ${message}`);
  }
  if (name === "AccessDeniedException") {
    throw new Error(`Textract: this AWS login may not use textract:AnalyzeExpense: ${message}`);
  }
}
