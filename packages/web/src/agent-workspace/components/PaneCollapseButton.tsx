/** Desktop rail control: collapse a side pane to free transcript width. */

import { PanelLeftCloseIcon, PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PaneCollapseButton({
  side,
  onCollapse,
  label,
}: {
  side: "left" | "right";
  onCollapse: () => void;
  label: string;
}) {
  const Icon = side === "left" ? PanelLeftCloseIcon : PanelRightCloseIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            data-testid={side === "left" ? "agent-left-collapse" : "agent-right-collapse"}
            onClick={onCollapse}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent side={side === "left" ? "right" : "left"}>{label}</TooltipContent>
    </Tooltip>
  );
}
