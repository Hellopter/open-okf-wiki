import { SendIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import type { MessageTree } from "../i18n";
import { SessionTranscript } from "./SessionTranscript";
import type { SessionRunLink } from "./session-run-links";
import type { useSessionConversation } from "./useSessionConversation";

type SessionConversation = ReturnType<typeof useSessionConversation>;

type ConversationPanelProps = {
  conversation: SessionConversation;
  runs: SessionRunLink[];
  onOpenRun: (runId: string) => void;
  onPromptSubmitted: (text: string) => void;
  t: MessageTree;
};

const BUSY_STATUSES = new Set(["streaming", "between_operations", "retrying", "compacting"]);

export function ConversationPanel({
  conversation,
  runs,
  onOpenRun,
  onPromptSubmitted,
  t,
}: ConversationPanelProps) {
  const [prompt, setPrompt] = useState("");

  const submitPrompt = async () => {
    const submitted = prompt;
    if (!(await conversation.send(submitted))) return;
    setPrompt("");
    onPromptSubmitted(submitted);
  };

  const isBusy = BUSY_STATUSES.has(conversation.status);
  const hasPrompt = Boolean(prompt.trim());
  /** When the agent is busy and the composer is empty, promote Stop as the primary action. */
  const emphasizeStop = isBusy && !hasPrompt;

  return (
    <>
      <SessionTranscript messages={conversation.messages} runs={runs} onOpenRun={onOpenRun} />
      <form
        className="shrink-0 border-t border-border bg-background px-4 py-3 md:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submitPrompt();
        }}
      >
        <div className="rounded-xl border border-border bg-muted/20 p-2 shadow-sm">
          <InputGroup className="border-0 bg-transparent shadow-none">
            <InputGroupTextarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (hasPrompt) void submitPrompt();
                }
              }}
              placeholder={isBusy ? t.workbench.promptBusy : t.workbench.promptIdle}
              rows={2}
              aria-busy={isBusy || undefined}
              aria-keyshortcuts="Enter"
              title={t.workbench.send}
            />
            <InputGroupAddon align="block-end" className="justify-end gap-1">
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant={emphasizeStop ? "outline" : "default"}
                disabled={!hasPrompt}
                aria-label={t.workbench.send}
                title={t.workbench.send}
              >
                <SendIcon />
              </InputGroupButton>
              {isBusy ? (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant={emphasizeStop ? "default" : "outline"}
                  onClick={() => void conversation.abort()}
                  aria-label={t.workbench.stop}
                  title={t.workbench.stop}
                >
                  <SquareIcon />
                </InputGroupButton>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
        </div>
      </form>
    </>
  );
}
