/** Desktop rail control: collapse the left session pane to free transcript width. */

import { PanelLeftCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PaneCollapseButton({
  onCollapse,
  label,
}: {
  onCollapse: () => void;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            data-testid="agent-left-collapse"
            onClick={onCollapse}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <PanelLeftCloseIcon />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
