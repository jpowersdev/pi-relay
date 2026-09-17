/**
 * Durable session relay for Pi.
 *
 * /relay [focus]
 *
 * Asks the current agent to write a durable handoff, then starts a fresh
 * session that reads and confirms the handoff. The source session remains
 * intact and is recorded as the new session's parent.
 */
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const HANDOFF_DIRECTORY = join(homedir(), ".pi", "agent", "handoffs");
const MAX_HANDOFF_BYTES = 128 * 1024;
const RELAY_SUFFIX = " · relay";

type ModelReference = {
  readonly provider: string;
  readonly id: string;
};

type PendingRelay = {
  readonly handoffPath: string;
  readonly sourceSessionFile: string | undefined;
  readonly sourceSessionId: string;
  readonly sourceModel: ModelReference;
  readonly targetModel: ModelReference;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly sessionName: string | undefined;
  readonly projectName: string;
  readonly focus: string;
};

type ActiveRelay = {
  readonly settle: () => void;
};

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

type RelayEntryData = {
  readonly targetModel?: ModelReference;
  readonly thinkingLevel?: ThinkingLevel;
};

function getRelayEntryData(ctx: ExtensionContext): RelayEntryData | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== "pi-relay" ||
      typeof entry.data !== "object" ||
      !entry.data
    ) {
      continue;
    }

    const data = entry.data as RelayEntryData;
    if (
      typeof data.targetModel?.provider !== "string" ||
      typeof data.targetModel.id !== "string"
    ) {
      return undefined;
    }
    return data;
  }
  return undefined;
}

async function selectTargetModel(
  ctx: ExtensionCommandContext,
): Promise<ModelReference | undefined> {
  if (!ctx.model) return undefined;

  const currentKey = `${ctx.model.provider}/${ctx.model.id}`;
  const available = ctx.modelRegistry.getAvailable();
  const references = available
    .map((model) => ({ provider: model.provider, id: model.id }))
    .sort((left, right) => {
      const leftKey = `${left.provider}/${left.id}`;
      const rightKey = `${right.provider}/${right.id}`;
      if (leftKey === currentKey) return -1;
      if (rightKey === currentKey) return 1;
      return leftKey.localeCompare(rightKey);
    });

  if (!references.some((model) => `${model.provider}/${model.id}` === currentKey)) {
    references.unshift({ provider: ctx.model.provider, id: ctx.model.id });
  }

  const choices = references.map((model) => {
    const key = `${model.provider}/${model.id}`;
    return {
      label: key === currentKey ? `Current · ${key}` : key,
      model,
    };
  });
  const selected = await ctx.ui.select(
    "Select the model for the new session",
    choices.map((choice) => choice.label),
  );
  return choices.find((choice) => choice.label === selected)?.model;
}

function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "session";
}

async function allocateHandoffPath(cwd: string, sessionId: string): Promise<string> {
  await mkdir(HANDOFF_DIRECTORY, { recursive: true, mode: 0o700 });
  await chmod(HANDOFF_DIRECTORY, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    HANDOFF_DIRECTORY,
    `${safeName(basename(cwd))}-${timestamp}-${safeName(sessionId).slice(0, 12)}.md`,
  );
}

function buildWritingPrompt(relay: PendingRelay): string {
  const focus = relay.focus
    ? `\nThe user requested this focus for the replacement session:\n${relay.focus}\n`
    : "";
  return `Prepare a durable handoff for a fresh Pi session. This is a relay-control turn: do not continue implementation or make project changes.

Inspect the current repository state as needed using read-only commands, including git status and relevant diffs when this is a Git repository. Then use the write tool to create this exact file:

${relay.handoffPath}

The handoff must be concise but sufficient for another agent to continue safely. Include:

# Session Relay
## Objective and Acceptance Criteria
## Constraints and User Preferences
## Current State
## Completed Work
## Key Decisions and Rationale
## Relevant and Modified Files
## Git State
## Tests and Verification
## Open Questions, Risks, and Blockers
## Exact Next Steps
## Recovery Metadata

Distinguish verified facts from assumptions. Record exact test commands and outcomes when known. In Recovery Metadata include the source session id and source session file shown below. Do not include credentials, secrets, hidden reasoning, or large file contents. Keep the file below 128 KiB.${focus}
Source session id: ${relay.sourceSessionId}
Source session file: ${relay.sourceSessionFile ?? "ephemeral session (no file)"}
Source model: ${relay.sourceModel.provider}/${relay.sourceModel.id}
Requested target model: ${relay.targetModel.provider}/${relay.targetModel.id}

After the write succeeds, respond with only a brief statement that the handoff was written. The relay extension will validate it and perform the session switch automatically.`;
}

async function validateAndSealHandoff(relay: PendingRelay): Promise<void> {
  const info = await lstat(relay.handoffPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("the handoff path is not a regular file");
  }
  if (info.size === 0) {
    throw new Error("the handoff file is empty");
  }
  if (info.size > MAX_HANDOFF_BYTES) {
    throw new Error(`the handoff exceeds ${MAX_HANDOFF_BYTES} bytes`);
  }

  const body = await readFile(relay.handoffPath, "utf8");
  if (!body.trim()) {
    throw new Error("the handoff contains no text");
  }

  const metadata = [
    "<!-- pi-relay",
    `source-session-id: ${relay.sourceSessionId}`,
    `source-session-file: ${relay.sourceSessionFile ?? "ephemeral"}`,
    `source-model: ${relay.sourceModel.provider}/${relay.sourceModel.id}`,
    `target-model: ${relay.targetModel.provider}/${relay.targetModel.id}`,
    `created-at: ${new Date().toISOString()}`,
    "-->",
    "",
  ].join("\n");

  await writeFile(relay.handoffPath, `${metadata}${body}`, { mode: 0o600 });
  await chmod(relay.handoffPath, 0o600);
}

function buildKickoff(relay: PendingRelay): string {
  return `This is a fresh session receiving work from a previous session.

Read the durable handoff at:
${relay.handoffPath}

Treat the handoff as a fallible summary, not as authority. Verify its important claims against the current repository state, including git status and relevant diffs. Do not load the old transcript unless a specific missing detail requires it; the source session remains available at:
${relay.sourceSessionFile ?? "(ephemeral source session; no session file)"}

For this first turn, remain read-only. Reply with a concise confirmation covering:
1. your understanding of the objective,
2. the current state and unresolved issues,
3. the exact next action you recommend.

Do not modify files or continue implementation until the user responds.`;
}

function relaySessionName(sessionName: string | undefined, projectName: string): string {
  if (!sessionName) return `${projectName}${RELAY_SUFFIX}`;
  return sessionName.endsWith(RELAY_SUFFIX) ? sessionName : `${sessionName}${RELAY_SUFFIX}`;
}

export default function relay(pi: ExtensionAPI) {
  let activeRelay: ActiveRelay | undefined;

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;

    const relayData = getRelayEntryData(ctx);
    if (!relayData?.targetModel) return;

    const targetModel = ctx.modelRegistry.find(
      relayData.targetModel.provider,
      relayData.targetModel.id,
    );
    if (!targetModel) {
      ctx.ui.notify(
        `Relay target model is unavailable: ${relayData.targetModel.provider}/${relayData.targetModel.id}`,
        "error",
      );
      return;
    }

    // setup() records the requested model in the session, but Pi creates the
    // replacement runtime before setup() runs. Activate it explicitly from the
    // freshly-bound extension instance before withSession() sends the kickoff.
    const alreadySelected =
      ctx.model?.provider === targetModel.provider && ctx.model.id === targetModel.id;
    const selected = alreadySelected || (await pi.setModel(targetModel));
    if (!selected) {
      ctx.ui.notify(
        `Relay target model has no configured credentials: ${targetModel.provider}/${targetModel.id}`,
        "error",
      );
      return;
    }
    if (relayData.thinkingLevel) {
      pi.setThinkingLevel(relayData.thinkingLevel);
    }
  });

  pi.registerCommand("relay", {
    description: "Write a durable handoff and continue in a fresh session with a model selector",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("relay requires interactive mode", "error");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Run /relay when the agent is idle with no queued messages", "warning");
        return;
      }
      if (activeRelay) {
        ctx.ui.notify("A relay is already in progress", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model is currently selected", "error");
        return;
      }

      const targetModel = await selectTargetModel(ctx);
      if (!targetModel) {
        ctx.ui.notify("Relay cancelled", "info");
        return;
      }

      const activeTools = new Set(pi.getActiveTools());
      if (!activeTools.has("write") && !activeTools.has("bash")) {
        ctx.ui.notify("relay requires the write or bash tool to create its handoff", "error");
        return;
      }
      if (!activeTools.has("read") && !activeTools.has("bash")) {
        ctx.ui.notify("relay requires the read or bash tool in the replacement session", "error");
        return;
      }

      const sourceModel = { provider: ctx.model.provider, id: ctx.model.id };
      const sourceSessionId = ctx.sessionManager.getSessionId();
      let handoffPath: string;
      try {
        handoffPath = await allocateHandoffPath(ctx.cwd, sourceSessionId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Cannot prepare relay handoff directory: ${detail}`, "error");
        return;
      }

      const relayState: PendingRelay = {
        handoffPath,
        sourceSessionFile: ctx.sessionManager.getSessionFile(),
        sourceSessionId,
        sourceModel,
        targetModel,
        thinkingLevel: ctx.thinkingLevel,
        sessionName: pi.getSessionName(),
        projectName: basename(ctx.cwd),
        focus: args.trim(),
      };

      const settled = new Promise<void>((resolve) => {
        activeRelay = { settle: resolve };
      });
      ctx.ui.notify(`Preparing relay handoff for ${targetModel.provider}/${targetModel.id}`, "info");
      try {
        pi.sendUserMessage(buildWritingPrompt(relayState));
        await settled;
      } catch (error) {
        activeRelay = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Relay stopped: ${detail}. Current session unchanged.`, "error");
        return;
      }
      activeRelay = undefined;

      try {
        await validateAndSealHandoff(relayState);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Relay stopped: ${detail}. Current session unchanged.`, "error");
        return;
      }

      const kickoff = buildKickoff(relayState);
      const result = await ctx.newSession({
        parentSession: relayState.sourceSessionFile,
        setup: async (sessionManager) => {
          sessionManager.appendModelChange(relayState.targetModel.provider, relayState.targetModel.id);
          if (relayState.thinkingLevel) {
            sessionManager.appendThinkingLevelChange(relayState.thinkingLevel);
          }
          sessionManager.appendSessionInfo(
            relaySessionName(relayState.sessionName, relayState.projectName),
          );
          sessionManager.appendCustomEntry("pi-relay", {
            handoffPath: relayState.handoffPath,
            sourceSessionFile: relayState.sourceSessionFile,
            sourceSessionId: relayState.sourceSessionId,
            targetModel: relayState.targetModel,
            thinkingLevel: relayState.thinkingLevel,
          });
        },
        withSession: async (next) => {
          const actualModel = next.model;
          if (
            !actualModel ||
            actualModel.provider !== relayState.targetModel.provider ||
            actualModel.id !== relayState.targetModel.id
          ) {
            next.ui.notify(
              `Relay stopped: could not activate ${relayState.targetModel.provider}/${relayState.targetModel.id}`,
              "error",
            );
            return;
          }
          next.ui.notify(
            `Relay ready on ${relayState.targetModel.provider}/${relayState.targetModel.id}`,
            "info",
          );
          await next.sendUserMessage(kickoff);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify(`Relay cancelled; handoff retained at ${relayState.handoffPath}`, "info");
      }
    },
  });

  pi.on("agent_settled", () => {
    activeRelay?.settle();
  });
}
