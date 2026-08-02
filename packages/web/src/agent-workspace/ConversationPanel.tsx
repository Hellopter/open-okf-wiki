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
        <InputGroup>
          <InputGroupTextarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              conversation.status === "idle" ? t.workbench.promptIdle : t.workbench.promptBusy
            }
            rows={2}
          />
          <InputGroupAddon align="block-end" className="justify-end">
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              disabled={!prompt.trim()}
              aria-label={t.workbench.send}
              title={t.workbench.send}
            >
              <SendIcon />
            </InputGroupButton>
            {conversation.status !== "idle" ? (
              <InputGroupButton
                size="icon-sm"
                variant="outline"
                onClick={() => void conversation.abort()}
                aria-label={t.workbench.stop}
                title={t.workbench.stop}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : null}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </>
  );
}
