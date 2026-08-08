import { createWikiCore } from "@okf-wiki/wiki-agent-kit";
import { createProductionExtension } from "../dist/extension.js";

export default createProductionExtension(createWikiCore());
