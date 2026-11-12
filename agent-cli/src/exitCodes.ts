/**
 * Process exit codes. These are part of the public contract: service managers,
 * scripts, and fleet tooling may branch on them, so a code never changes meaning.
 */
export const EXIT = {
  /** Success, or a booking that ended normally. */
  OK: 0,
  /** A runtime failure: server unreachable, host key rejected, a failed check, a crash loop. */
  ERROR: 1,
  /** Bad command line or bad settings (unknown option, invalid agent.json, invalid proxy). */
  USAGE: 2,
  /** Stopped with Ctrl+C (SIGINT). Saved booking state is cleared. */
  INTERRUPTED: 130,
  /** Stopped by the system or a service manager (SIGTERM). Saved booking state is kept for the next start. */
  TERMINATED: 143,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Configuration failures should not be retried forever by service managers. */
export class UsageError extends Error {}
