import { WikiRunEventSchema, WikiRunGetResponseSchema, WikiRunIndexEventSchema } from "@okf-wiki/contract/wiki-runs";

function parseEventData(data: string): unknown {
  return JSON.parse(data) as unknown;
}

export function parseWikiRunIndexEvent(data: string) {
  return WikiRunIndexEventSchema.parse(parseEventData(data));
}

export function parseWikiRunSnapshotEvent(data: string) {
  return WikiRunGetResponseSchema.parse(parseEventData(data)).snapshot;
}

export function parseWikiRunEvent(data: string) {
  return WikiRunEventSchema.parse(parseEventData(data));
}
