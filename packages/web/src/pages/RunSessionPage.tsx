import type { WikiRunListItem, WorkspaceConfig } from "@okf-wiki/contract";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getRunIndex, getWorkspace } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { WorkbenchShell } from "../shells/WorkbenchShell";

/** A durable operator-session handoff without reinstating chat-owned Run control. */
export function RunSessionPage() {
  const { id = "", sessionId = "" } = useParams<{ id: string; sessionId: string }>();
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [runs, setRuns] = useState<WikiRunListItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const [workspaceResult, index] = await Promise.all([getWorkspace(id), getRunIndex(id)]);
    setWorkspace(workspaceResult.workspace);
    setRuns(index.runs.filter((run) => run.sessionId === sessionId));
  }, [id, sessionId]);

  useEffect(() => {
    let cancelled = false;
    void load()
      .catch((nextError) => {
        if (!cancelled) setError(nextError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading) return <LoadingState />;

  return (
    <WorkbenchShell workspaceId={id} workspaceName={workspace?.name} mode="operate" immersive>
      <main
        className="flex min-h-0 flex-1 flex-col bg-background"
        data-testid="run-session-handoff"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 lg:px-6">
          <Link
            to={`/w/${encodeURIComponent(id)}/runs`}
            title="Back to Runs"
            aria-label="Back to Runs"
          >
            <Button size="icon-sm" variant="outline">
              <ArrowLeft />
            </Button>
          </Link>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">Session</h2>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{sessionId}</p>
          </div>
        </header>
        {error ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
        ) : null}
        <section className="min-h-0 overflow-y-auto px-4 py-5 lg:px-6">
          <h3 className="text-sm font-medium">Linked Runs</h3>
          {runs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No durable Runs are linked to this session.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-border border-y border-border">
              {runs.map((run) => (
                <Link
                  key={run.runId}
                  to={`/w/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`}
                  className="flex items-center justify-between gap-3 py-3 text-sm no-underline hover:text-primary"
                >
                  <span className="font-mono text-xs text-muted-foreground">{run.runId}</span>
                  <span className="flex items-center gap-2">
                    {run.state.replaceAll("_", " ")}
                    <ExternalLink className="size-3" />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </WorkbenchShell>
  );
}
