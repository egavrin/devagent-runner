#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { LocalRunner } from "@devagent-runner/local-runner";
import {
  ClaudeAdapter,
  CodexAdapter,
  DevAgentAdapter,
  OpenCodeAdapter,
} from "@devagent-runner/adapters";
import { validateTaskExecutionRequest } from "@devagent-sdk/validation";

function usage(): never {
  console.error("Usage: devagent-runner run --request <file> | cancel <run-id> | inspect <run-id>");
  process.exit(1);
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const runner = new LocalRunner({
    adapters: [
      new DevAgentAdapter(),
      new CodexAdapter(),
      new ClaudeAdapter(),
      new OpenCodeAdapter(),
    ],
  });

  if (command === "run") {
    const index = args.indexOf("--request");
    if (index === -1 || !args[index + 1]) usage();
    const requestPath = args[index + 1]!;
    const request = validateTaskExecutionRequest(JSON.parse(await readFile(requestPath, "utf-8")));
    const { runId } = await runner.startTask(request);
    const result = await runner.awaitResult(runId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (command === "cancel") {
    if (!args[0]) usage();
    await runner.cancel(args[0]);
    process.stdout.write(`Cancelled ${args[0]}\n`);
    return;
  }

  if (command === "inspect") {
    if (!args[0]) usage();
    const metadata = await runner.inspect(args[0]);
    process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
    return;
  }

  usage();
}

void main();
