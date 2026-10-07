export const KEYS_URL = "https://tanvo.ai/settings/apikeys";

/** Base class. `code` is the API's stable error string; `status` is the HTTP status (0 for network errors). */
export class TanvoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
    public readonly issues: string[] = [],
    public readonly retryAfter?: number,
  ) {
    super(issues.length ? `${message} (${issues.join("; ")})` : message);
    this.name = new.target.name;
  }
}
/** Bad parameters, a refused prompt, a file too large, or a record that does not exist. Do not retry. */
export class InvalidRequestError extends TanvoError {}
/** No identity, or an invalid / revoked API key. */
export class AuthError extends TanvoError {}
/** Out of credits, the free tier does not cover this, or a limit was hit. `busy` and `rate_limited` clear by waiting. */
export class QuotaError extends TanvoError {}
/** The service or an upstream model failed. Safe to retry with the same requestKey. */
export class ServiceError extends TanvoError {}
/** A webhook's signature or timestamp did not check out. */
export class WebhookVerificationError extends TanvoError {}

const KINDS: Array<[typeof TanvoError, string[]]> = [
  [InvalidRequestError, ["invalid", "rejected", "too_large", "not_found"]],
  [AuthError, ["unauthorized", "invalid_api_key", "unknown_anon_id"]],
  [QuotaError, ["credits", "allowance", "needs_api_key", "anon_ip_daily", "trial_closed", "rate_limited", "limit", "busy"]],
];
const NEEDS_KEY = new Set(["needs_api_key", "allowance", "anon_ip_daily", "trial_closed"]);

export function errorFor(code: string, message: string, status: number, issues: string[] = [], retryAfter?: number, hasKey = true): TanvoError {
  const Cls = KINDS.find(([, codes]) => codes.includes(code))?.[0] ?? ServiceError;
  const text = NEEDS_KEY.has(code) && !hasKey ? `${message} Get a key at ${KEYS_URL} (then pass apiKey or set TANVO_API_KEY).` : message;
  return new Cls(code, text, status, issues, retryAfter);
}
