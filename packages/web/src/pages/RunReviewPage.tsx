import type {
  CandidateDiffRead,
  CandidatePageRead,
  RunCommand,
  WikiRunSnapshot,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { Check, FileDiff, MessageSquarePlus, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  dispatchWikiRunCommand,
  getCandidateDiff,
  getCandidatePage,
  getCandidateTree,
  getWikiRun,
  getWorkspace,
  hasApiErrorCode,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { newCommandId } from "../lib/command-id";
import { WorkbenchShell } from "../shells/WorkbenchShell";

export function RunReviewPage() {
  const { id = "", runId = "" } = useParams<{ id: string; runId: string }>();
  const [params, setParams] = useSearchParams();
  const candidateDigest = params.get("candidate") ?? "";
  const pagePath = params.get("page") ?? "index.md";
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [snapshot, setSnapshot] = useState<WikiRunSnapshot | null>(null);
  const [page, setPage] = useState<CandidatePageRead | null>(null);
  const [diff, setDiff] = useState<CandidateDiffRead | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [lineStart, setLineStart] = useState("1");
  const [lineEnd, setLineEnd] = useState("1");
  const [comment, setComment] = useState("");
  const [pageInput, setPageInput] = useState(pagePath);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!id || !runId) return;
    const [workspaceResult, run] = await Promise.all([getWorkspace(id), getWikiRun(id, runId)]);
    const selected = candidateDigest || run.snapshot.candidates.at(-1)?.digest;
    if (!selected) throw new Error("No candidate is available for review.");
    const [tree, nextPage, nextDiff] = await Promise.all([
      getCandidateTree(id, runId, selected),
      getCandidatePage(id, runId, selected, pagePath),
      getCandidateDiff(id, runId, selected, pagePath),
    ]);
    setWorkspace(workspaceResult.workspace);
    setSnapshot(run.snapshot);
    setPage(nextPage);
    setDiff(nextDiff);
    setPages(tree.pages);
    if (!candidateDigest) setParams({ candidate: selected, page: pagePath }, { replace: true });
  }, [candidateDigest, id, pagePath, runId, setParams]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh()
      .catch((nextError) => {
        if (!cancelled) setError(nextError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const selectedCandidateDigest = page?.candidateDigest ?? candidateDigest;
  const threads = useMemo(
    () =>
      snapshot?.reviewThreads.filter(
        (thread) => thread.candidateDigest === selectedCandidateDigest,
      ) ?? [],
    [selectedCandidateDigest, snapshot?.reviewThreads],
  );

  const dispatch = async (build: (latest: WikiRunSnapshot) => RunCommand) => {
    if (!id || !runId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let latest = (await getWikiRun(id, runId)).snapshot;
      setSnapshot(latest);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await dispatchWikiRunCommand(id, build(latest));
          break;
        } catch (nextError) {
          if (attempt === 0 && hasApiErrorCode(nextError, "stale_revision")) {
            latest = (await getWikiRun(id, runId)).snapshot;
            setSnapshot(latest);
            continue;
          }
          throw nextError;
        }
      }
      await refresh();
      toast.success("Review updated");
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSubmitting(false);
    }
  };

  const createThread = async () => {
    if (!snapshot || !page || !comment.trim()) return;
    const startLine = Number(lineStart);
    const endLine = Number(lineEnd);
    const lines = page.content.replace(/\r\n/g, "\n").split("\n");
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine > lines.length
    ) {
      setError(new Error("Choose a valid line range."));
      return;
    }
    const body = comment.trim();
    await dispatch((latest) => ({
      type: "create_review_thread",
      commandId: newCommandId(),
      runId: latest.runId,
      expectedRevision: latest.revision,
      anchor: {
        candidateDigest: page.candidateDigest,
        pagePath,
        startLine,
        endLine,
      },
      body,
    }));
    setComment("");
  };

  const requestRepair = () => {
    if (!snapshot) return;
    const open = threads.filter((thread) => thread.state === "open");
    if (open.length === 0) return;
    const threadIds = open.map((thread) => thread.threadId);
    void dispatch((latest) => {
      const currentThreadIds = threadIds.filter((threadId) =>
        latest.reviewThreads.some(
          (thread) => thread.threadId === threadId && thread.state === "open",
        ),
      );
      if (currentThreadIds.length === 0)
        throw new Error("The selected review threads have already changed.");
      return {
        type: "request_repair",
        commandId: newCommandId(),
        runId: latest.runId,
        expectedRevision: latest.revision,
        threadIds: currentThreadIds,
      };
    });
  };

  if (loading) return <LoadingState />;
  return (
    <WorkbenchShell workspaceId={id} workspaceName={workspace?.name} mode="operate" immersive>
      <main
        className="flex min-h-0 flex-1 flex-col bg-background"
        data-testid="run-candidate-review"
      >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 lg:px-6">
          <div className="min-w-0">
            <Link
              to={`/w/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`}
              className="text-xs text-muted-foreground no-underline hover:underline"
            >
              Run
            </Link>
            <h2 className="mt-1 text-base font-semibold">Candidate review</h2>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <select
              aria-label="Candidate"
              className="h-8 max-w-44 rounded-md border border-input bg-background px-2 font-mono text-xs"
              value={selectedCandidateDigest}
              onChange={(event) => setParams({ candidate: event.target.value, page: pagePath })}
            >
              {snapshot?.candidates.map((candidate) => (
                <option key={candidate.candidateId} value={candidate.digest}>
                  {candidate.digest.slice(0, 16)}
                </option>
              ))}
            </select>
            <select
              aria-label="Candidate page"
              className="h-8 max-w-52 rounded-md border border-input bg-background px-2 font-mono text-xs"
              value={pagePath}
              onChange={(event) =>
                setParams({ candidate: selectedCandidateDigest, page: event.target.value })
              }
            >
              {(pages.length ? pages : [pagePath]).map((candidatePage) => (
                <option key={candidatePage} value={candidatePage}>
                  {candidatePage}
                </option>
              ))}
            </select>
            <Input
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              className="h-8 w-36 font-mono text-xs"
              aria-label="Candidate page path"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setParams({
                  candidate: selectedCandidateDigest,
                  page: pageInput.trim() || "index.md",
                })
              }
            >
              Open
            </Button>
          </div>
        </header>
        {error ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="min-h-0 overflow-y-auto px-4 py-5 lg:px-6">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileDiff className="size-3" />
              <span className="font-mono">{selectedCandidateDigest.slice(0, 16)}</span>
              <span>{pagePath}</span>
            </div>
            <pre className="mt-4 overflow-x-auto border-y border-border py-3 text-xs leading-6">
              <code>
                {page?.content.split("\n").map((line, index) => (
                  <div
                    key={`${index}-${line}`}
                    className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 px-1 hover:bg-muted/50"
                  >
                    <span className="select-none text-right text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-words">{line || " "}</span>
                  </div>
                ))}
              </code>
            </pre>
            <h3 className="mt-6 text-sm font-medium">Version diff</h3>
            <div className="mt-2 border-y border-border py-2 font-mono text-xs leading-5">
              {diff?.lines.map((line, index) => (
                <div
                  key={`${line.kind}-${index}`}
                  className={
                    line.kind === "add"
                      ? "bg-success/10 text-success"
                      : line.kind === "remove"
                        ? "bg-destructive/10 text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} {line.text}
                </div>
              ))}
            </div>
          </section>
          <aside className="min-h-0 overflow-y-auto border-t border-border px-4 py-5 xl:border-t-0 xl:border-l">
            <h3 className="text-sm font-medium">Line comment</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Input
                type="number"
                min="1"
                value={lineStart}
                onChange={(event) => setLineStart(event.target.value)}
                aria-label="Start line"
              />
              <Input
                type="number"
                min="1"
                value={lineEnd}
                onChange={(event) => setLineEnd(event.target.value)}
                aria-label="End line"
              />
            </div>
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              className="mt-2 min-h-24 resize-none"
              placeholder="Review note"
            />
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void createThread()}
              disabled={submitting || !comment.trim()}
            >
              <MessageSquarePlus />
              Add comment
            </Button>
            <h3 className="mt-7 text-sm font-medium">Evidence</h3>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {page?.evidence.length ? (
                page.evidence.map((item, index) => (
                  <li key={`${item.line}-${index}`}>
                    L{item.line} {item.source}
                  </li>
                ))
              ) : (
                <li>No inline evidence on this page.</li>
              )}
            </ul>
            <h3 className="mt-7 text-sm font-medium">Threads</h3>
            <div className="mt-2 space-y-3">
              {threads.length ? (
                threads.map((thread) => (
                  <div key={thread.threadId} className="border-l border-border pl-3 text-xs">
                    <div className="text-muted-foreground">
                      L{thread.startLine}-{thread.endLine} {thread.state}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{thread.body}</p>
                    {thread.state === "open" && snapshot ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="mt-1"
                        onClick={() =>
                          void dispatch((latest) => ({
                            type: "resolve_review_thread",
                            commandId: newCommandId(),
                            runId: latest.runId,
                            expectedRevision: latest.revision,
                            threadId: thread.threadId,
                          }))
                        }
                      >
                        <Check />
                        Resolve
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No comments yet.</p>
              )}
            </div>
            <Button
              variant="outline"
              className="mt-5 w-full"
              onClick={requestRepair}
              disabled={submitting || !threads.some((thread) => thread.state === "open")}
            >
              <Wrench />
              Request repair
            </Button>
          </aside>
        </div>
      </main>
    </WorkbenchShell>
  );
}
