#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectWiki } from "./inspect.js";
import { repositoryRoot } from "./git.js";
import { validateWiki } from "./validate.js";
import { installWikiWorkflows } from "./workflows.js";

interface ParsedCommand {
  command: "install" | "inspect" | "finalize" | "help";
  cwd: string;
  wikiDirectory: string;
}

export async function runCli(argv: string[], output: Pick<Console, "log" | "error"> = console): Promise<number> {
  try {
    const parsed = parseCommand(argv);
    if (parsed.command === "help") {
      output.log(JSON.stringify({
        ok: true,
        usage: [
          "okf-wiki install [--cwd <workspace>]",
          "okf-wiki inspect [--cwd <workspace>]",
          "okf-wiki finalize [--cwd <workspace>]",
        ],
      }, null, 2));
      return 0;
    }

    if (parsed.command === "inspect") {
      const inspection = await inspectWiki(parsed.cwd);
      output.log(JSON.stringify({ ok: true, ...inspection }, null, 2));
      return 0;
    }

    const root = await repositoryRoot(parsed.cwd);
    if (parsed.command === "install") {
      const installed = installWikiWorkflows(root);
      output.log(JSON.stringify({ ok: true, ...installed }, null, 2));
      return 0;
    }

    const validation = await validateWiki(root, parsed.wikiDirectory);
    output.log(JSON.stringify(validation, null, 2));
    return validation.ok ? 0 : 1;
  } catch (error) {
    output.error(JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2));
    return 1;
  }
}

function parseCommand(argv: string[]): ParsedCommand {
  const [rawCommand = "help", ...rest] = argv;
  if (rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    if (rest.length > 0) throw new Error("help does not accept options");
    return { command: "help", cwd: process.cwd(), wikiDirectory: "wiki" };
  }
  if (rawCommand !== "install" && rawCommand !== "inspect" && rawCommand !== "finalize") {
    throw new Error(`unknown command: ${rawCommand}`);
  }

  let cwd = process.cwd();
  let wikiDirectory = "wiki";
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (option === "--json") continue;
    if (option === "--cwd") {
      const value = rest[++index];
      if (!value) throw new Error("--cwd requires a directory");
      cwd = path.resolve(value);
      continue;
    }
    if (option === "--wiki") {
      throw new Error("--wiki is not supported; Wiki output is always wiki/");
    }
    throw new Error(`unknown option: ${option}`);
  }
  return { command: rawCommand, cwd, wikiDirectory };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  void main();
}

export { parseCommand };
