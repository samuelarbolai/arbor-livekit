import { serveMany } from '@upstash/workflow/nextjs';
import { rootWorkflow } from '@/lib/workflows/root';
import { perUserWorkflow } from '@/lib/workflows/per-user';

// Phase 6: serveMany mounts both workflows under one Next.js handler so
// `context.invoke(perUserWorkflow, ...)` from inside rootWorkflow can
// route by reference (no URL needed). The catch-all `[...any]` segment
// in the file path keeps the public URLs stable:
//   POST /api/tracking-workflow/root      → rootWorkflow
//   POST /api/tracking-workflow/per-user  → perUserWorkflow
// — same URLs the QStash schedule (Phase 7) and the manual trigger
// script use. Per the upstash-workflow-js skill: workflows that invoke
// each other MUST be registered in the same serveMany call.

export const { POST } = serveMany({
  root: rootWorkflow,
  'per-user': perUserWorkflow,
});
