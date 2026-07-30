/**
 * Failed-node list with RetryFailedNode / RerunNode actions.
 * Control chrome for RunCockpit only — not the produce receipt card.
 */

import type { WikiRunAttempt, WikiRunNode } from "@okf-wiki/contract";
import { Button } from "@/components/ui/button";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import type { WikiRunFailedNode } from "./wiki-run-view-model";

export type FailedNodesListProps = {
  failedNodes: WikiRunFailedNode[];
  submitting?: boolean;
  disabled?: boolean;
  onOpenNode?: (nodeKey: string) => void;
  onRetry: (node: WikiRunNode, attempt: WikiRunAttempt) => void;
  onRerun: (node: WikiRunNode) => void;
  /** Container test id (default run-inspector-failed-nodes). */
  testId?: string;
  retryTestId?: string;
  rerunTestId?: string;
  className?: string;
};

export function FailedNodesList({
  failedNodes,
  submitting = false,
  disabled = false,
  onOpenNode,
  onRetry,
  onRerun,
  testId = "run-inspector-failed-nodes",
  retryTestId = "run-inspector-retry",
  rerunTestId = "run-inspector-rerun",
  className = "flex flex-col gap-1",
}: FailedNodesListProps) {
  const { t } = useI18n();

  if (failedNodes.length === 0) return null;

  return (
    <div data-testid={testId} className={className}>
      <p className="okf-section-label">{t.agentWorkspace.failedNodes}</p>
      <ul className="flex flex-col gap-1">
        {failedNodes.map(({ node, attempt }) => (
          <li
            key={node.key}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs"
          >
            {onOpenNode ? (
              <button
                type="button"
                className="min-w-0 truncate font-mono font-medium hover:underline"
                onClick={() => onOpenNode(node.key)}
              >
                {node.key}
              </button>
            ) : (
              <span className="min-w-0 truncate font-mono">{node.key}</span>
            )}
            <span className="flex shrink-0 flex-wrap items-center gap-1">
              <StatusBadge status={attempt.state} />
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-testid={retryTestId}
                data-node-key={node.key}
                disabled={submitting || disabled}
                onClick={() => onRetry(node, attempt)}
              >
                {t.agentWorkspace.retryFailedNode}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid={rerunTestId}
                data-node-key={node.key}
                disabled={submitting || disabled}
                onClick={() => onRerun(node)}
              >
                {t.agentWorkspace.rerunNode}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
