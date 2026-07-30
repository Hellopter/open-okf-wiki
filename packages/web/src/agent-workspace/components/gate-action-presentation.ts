export type GateActionPresentation = "dock" | "sheet" | "drawer";

/** The one responsive placement contract for the mutable GateAction surface. */
export function gateActionPresentationForWidth(width: number): GateActionPresentation {
  if (width >= 1280) return "dock";
  if (width >= 768) return "sheet";
  return "drawer";
}
