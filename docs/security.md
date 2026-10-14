# Security

## Implemented (covered by tests unless noted)

| Control                                                                                                               | Where                                             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| First-run setup requires a one-time token (random, logged once, or `HLCC_SETUP_TOKEN`); setup works once, atomically  | `routes/auth.ts`, `repositories/auth.ts`          |
| scrypt password hashing, 12–128 character passwords; dummy verification for unknown users                             | `security/password.ts`                            |
| Generic login errors; login/setup failures rate-limited (5 per 15 min per IP)                                         | `routes/auth.ts`, `security/rateLimit.ts`         |
| Random 256-bit session tokens, only a SHA-256 stored; 12 h expiry; logout deletes the session                         | `repositories/auth.ts`                            |
| `HttpOnly`, `SameSite=Strict`, `Secure` when `HLCC_COOKIE_SECURE=true`                                                | `routes/auth.ts`                                  |
| CSRF: per-session token header on every authenticated write, plus Origin check                                        | `middleware.ts`                                   |
| Every data endpoint requires a session; only `/health` and auth endpoints are public                                  | `routes/api.ts`                                   |
| Helmet security headers, CSP (`default-src 'self'`), HSTS only when served over HTTPS                                 | `app.ts`                                          |
| 10 kB JSON body limit, Zod validation on all input, no stack traces in errors                                         | `app.ts`, `middleware.ts`                         |
| Secret redaction for audit details and collector errors; tests cover tokens, URL credentials, key blocks              | `security/redact.ts`                              |
| Registry input rejects URLs with credentials, path traversal, odd container names; only `monitor` capability accepted | `packages/shared/src/project.ts`, `routes/api.ts` |
| No shell, Docker socket or file-path access from the API                                                              | by construction                                   |
| Secret scan and `npm audit` in the quality gate and CI                                                                | `scripts/check-secrets.mjs`, CI                   |

## Not implemented yet

- Environment secret storage and encryption (Phase 7): design requires a key outside the repository and database, masked values, no secrets in audit records.
- Audit coverage for reads, alert delivery, SSRF-safe HTTP checks (Phase 3: targets restricted to configured URLs with timeouts).
- Persistent or distributed rate limiting (in memory, single instance).
- Password change and multi-user roles (single admin only).
- Cloudflare Access in front of the hostname. Treat it as an extra layer, not a replacement for the app login.

## Operating guidance

- Bind to loopback (`HLCC_HOST=127.0.0.1`) and publish only via an approved tunnel or Tailscale.
- Set `HLCC_COOKIE_SECURE=true` and `HLCC_TRUST_PROXY=true` behind HTTPS proxies, and list the public origin in `HLCC_ALLOWED_ORIGINS`.
- Never mount the Docker socket into this container. When Docker access is needed, use a separate restricted helper.
- The existing server has world-readable secret files (`shared.secrets`, some `.env`); this project does not read them. Fix their permissions separately.

## Threat notes

Logs, container output and repository text are untrusted data and are never executed or followed. A compromised browser session can only call the same allowlisted, read-mostly endpoints; there is no path from the API to command execution in this release.
