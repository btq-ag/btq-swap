export const DOMAIN_ERROR_STATUS = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  NOT_REGISTERED: 401,
  TOS_REQUIRED: 403,
  LINK_REQUIRED: 403,
  USER_BANNED: 403,
  BOOK_PAUSED: 409,
  NO_LIQUIDITY: 409,
  INSUFFICIENT_INVENTORY: 409,
  RATE_LIMITED: 429,
  EXPIRED: 400,
  CHAIN_UNAVAILABLE: 503,
} as const;

export type DomainErrorCode = keyof typeof DOMAIN_ERROR_STATUS;

export class DomainError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: DomainErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message || code);
    this.name = 'DomainError';
    this.httpStatus = DOMAIN_ERROR_STATUS[code];
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError || (e instanceof Error && e.name === 'DomainError' && typeof (e as { code?: unknown }).code === 'string');
}
