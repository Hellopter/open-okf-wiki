import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleIcon,
  Loader2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_TONE_TEXT,
  type StatusDescriptor,
  type StatusMotion,
  type StatusTone,
} from "./status";

export type StatusGlyphProps = {
  tone?: StatusTone;
  motion?: StatusMotion;
  descriptor?: Pick<StatusDescriptor, "tone" | "motion">;
  className?: string;
  /** Accessible label; decorative when omitted. */
  label?: string;
};

export function StatusGlyph({
  tone: toneProp,
  motion: motionProp,
  descriptor,
  className,
  label,
}: StatusGlyphProps) {
  const tone = toneProp ?? descriptor?.tone ?? "neutral";
  const motion = motionProp ?? descriptor?.motion ?? "none";
  const shared = cn("size-4 shrink-0", STATUS_TONE_TEXT[tone], className);
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);

  if (motion === "spin") {
    return (
      <Loader2Icon className={cn(shared, "animate-spin")} data-slot="status-glyph" {...a11y} />
    );
  }

  if (tone === "success") {
    return <CheckCircle2Icon className={shared} data-slot="status-glyph" {...a11y} />;
  }
  if (tone === "destructive") {
    return <CircleAlertIcon className={shared} data-slot="status-glyph" {...a11y} />;
  }
  if (tone === "warning" || motion === "pulse") {
    return (
      <CircleDashedIcon
        className={cn(shared, motion === "pulse" && "animate-pulse")}
        data-slot="status-glyph"
        {...a11y}
      />
    );
  }
  // info / neutral resting state
  return <CircleIcon className={shared} data-slot="status-glyph" {...a11y} />;
}
