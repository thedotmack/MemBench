# Oracle notes — claude-mem-pro-001

Perfect-observer memory of session N (project claude-mem-pro,
2026-07-15 01:43–04:44 UTC). Everything below was established inside that
session; nothing is taken from what happened afterwards.

## Session goal and outcome

- **User task**: get all the messages data from the waitlist leads and build a
  private admin page explaining the makeup of lead types, what the messages
  reveal, and who the best leads are — built in full and pushed to Vercel
  behind admin permissions.
- **Outcome**: shipped. PR #50 (thedotmack/claude-mem-pro) merged into `main`
  (fast-forward `171e555..9e50d95`), Vercel production deploy succeeded, live
  as a new "Lead report" tab at cmem.ai/admin next to the existing Waitlist tab.

## Decisions made

- **Two "lead" domains, only one is relevant**: `email_waitlist` is the
  landing-page waitlist/contact capture ("leads" in this task's sense);
  `cloud_lead_cohorts` / `cloud_lead_eligibility` / `cloud_lead_claims`
  (migration 0025, `src/lib/pro/lead-grant.ts`) are billing/entitlement
  machinery for free-Pro grants and were deliberately left alone.
- **Isolated worktree**: work happened in a fresh worktree
  `claude-mem-pro-worktrees/admin-leads-report` on branch
  `feat/admin-leads-report` cut from `origin/main`, specifically to avoid
  touching the in-progress Turbopuffer migration branch
  (`codex/turbopuffer-only-launch`) checked out in the main working copy.
- **Reuse the existing admin gate unchanged**: no role system exists; access
  is a server-checked email allowlist reused exactly as-is for the new tab.
- **Pure analysis module**: lead classification/scoring lives in a module with
  no DB access so the logic is unit-testable; the API route fetches rows and
  calls the builder.

## File locations discovered

- **Waitlist schema**: `src/db/schema.ts:481-490` — `email_waitlist` table
  (id, email unique, source, note, referrer, confirmationSentAt, invitedAt,
  createdAt). The `note` column is the signup's free-text "message".
  `WaitlistEntry` type export at `src/db/schema.ts:586`.
- **Migrations**: `drizzle/0005_add_email_waitlist.sql` (table + created_at
  index), `drizzle/0006_enable_rls_email_waitlist.sql` (RLS deny-all except
  service role), `drizzle/0007_add_waitlist_note.sql` (adds `note`).
- **Public write path**: `src/app/api/waitlist/route.ts` — `POST /api/waitlist`,
  validates email, IP rate-limit via `src/lib/rate-limit.ts`, inserts with
  `onConflictDoNothing()`, sends Resend confirmation via
  `src/lib/email/waitlist-confirmation.ts`.
- **Admin read path**: `src/app/api/admin/waitlist/route.ts` —
  `GET /api/admin/waitlist`, selects id/email/source/note/createdAt ordered by
  createdAt desc capped at 20,000 rows, runs `buildWaitlistIntel()` from
  `src/lib/admin/waitlist-intel.ts`.
- **Admin gate core**: `src/lib/admin/auth.ts:11-25` — `isAdminUser()` against
  an allowlist built from a hardcoded default admin email plus the
  `ADMIN_EMAILS` env var.
- **Admin UI**: `src/app/(authenticated)/admin/page.tsx` (server component
  gate) and `src/app/(authenticated)/admin/AdminWaitlist.tsx` (client panel,
  polls every 30s — `POLL_MS = 30_000`).

## What was built (new/changed files on main)

- **`src/lib/admin/lead-report.ts`** (new, ~425 lines) — `buildLeadReport()`:
  pure transform of waitlist rows into the report payload. Answers three
  questions: lead segments (team clusters, known companies, corporate-solo,
  academic, individual — with counts and share), message themes (team
  adoption, AI agent workflow, memory/context pain points, competitor
  mentions, pricing interest — with example quotes), and a transparently
  scored best-lead ranking with per-lead reasons.
- **`src/app/api/admin/leads-report/route.ts`** (new) — admin-gated API route
  for the report.
- **`src/app/(authenticated)/admin/LeadReport.tsx`** (new, ~272 lines) — the
  "Lead report" tab UI, including a full verbatim log of every signup note.
- **`src/app/(authenticated)/admin/AdminDashboard.tsx`** (new) — tabbed admin
  shell ("Waitlist" / "Lead report" tabs).
- **Modified**: `admin/AdminWaitlist.tsx`, `admin/admin.css` (+125 lines),
  `admin/page.tsx`, `src/lib/admin/waitlist-intel.ts` (small tweak).
  8 files changed, 919 insertions, 8 deletions.

## Gotchas

- **Middleware does not check the allowlist**: `src/proxy.ts:32-33,54-77`
  (matcher covers `/admin` and `/api/admin`) only checks session validity —
  unauthenticated `/api/admin/*` gets a hidden 404, pages redirect to
  `/login`. The email-allowlist check happens in the page component
  (`notFound()` for non-admins) and in each `/api/admin/*` route handler.
  Any new admin surface must repeat the handler-level check.
- **Waitlist inserts bypass RLS**: RLS on `email_waitlist` is deny-all except
  service role; inserts go through the direct Postgres connection.
- **Verification stopped short of the browser**: typecheck, lint, full
  production build, synthetic-data runs of the scoring/theme logic, and an
  unauthenticated smoke test of the auth gate all passed, but nobody clicked
  through cmem.ai/admin as a logged-in admin during the session.

## State left behind

- **`main`** is at `9e50d95` with the Lead report shipped and deployed to
  Vercel production.
- **The temp worktree and branch were cleaned up** (`admin-leads-report`
  worktree removed after the merge).
- **The main working copy** stays on the Turbopuffer migration branch
  (`codex/turbopuffer-only-launch`, commit `2173442`), untouched by this work.
