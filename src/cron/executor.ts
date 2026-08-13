/**
 * Cron job executor — systemEvent is a no-op, agentTurn dispatches
 * via the injected dispatcher.
 *
 * Cron never imports Agent/AgentRegistry directly. The dependency goes
 * one way only: the bootstrap layer injects a `dispatch` callback
 * bound to `Dispatcher.dispatchSynthetic()`, and cron calls it with
 * a synthesized `InboundMessageContext` whose `webUserId` is the
 * job's `ownerId`.
 */

import { getChildLogger } from "../utils/logger.js";
import type { CronExecutionResult, CronJob, PayloadAgentTurn } from "./types.js";
import type { InboundMessageContext, ChannelId } from "../channels/ChannelAdapter.js";

const logger = getChildLogger("cron-executor");

export interface CronDispatcher {
  /**
   * Dispatch a synthetic inbound message. Caller wraps
   * `Dispatcher.dispatchSynthetic()` or a stub for tests.
   */
  dispatch(ctx: InboundMessageContext): Promise<unknown>;
}

export interface CronExecutorOptions {
  /** Injected by bootstrap — bound to Dispatcher.dispatchSynthetic(). */
  dispatch: CronDispatcher["dispatch"];
}

/**
 * Create a Cron job executor. Returns an object with `executeJob`.
 */
export function createCronExecutor(options: CronExecutorOptions): {
  executeJob(job: CronJob): Promise<CronExecutionResult>;
} {
  const { dispatch } = options;

  async function executeJob(job: CronJob): Promise<CronExecutionResult> {
    const { payload } = job;
    logger.info(
      { jobId: job.id, jobName: job.name, ownerId: job.ownerId, payloadKind: payload.kind },
      "Executing cron job",
    );
    try {
      switch (payload.kind) {
        case "systemEvent":
          // systemEvent is just a log — no agent involvement.
          return {
            status: "ok",
            summary: `System event: ${payload.message.slice(0, 200)}`,
          };

        case "agentTurn":
          return await executeAgentTurn(job, payload, dispatch);

        default:
          return {
            status: "error",
            error: `Unknown payload kind: ${(payload as { kind: string }).kind}`,
          };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, error }, "Cron job execution failed");
      return { status: "error", error };
    }
  }

  return { executeJob };
}

async function executeAgentTurn(
  job: CronJob,
  payload: PayloadAgentTurn,
  dispatch: CronDispatcher["dispatch"],
): Promise<CronExecutionResult> {
  // Route the reply through payload.deliver/channel/to when set so the scheduled
  // agent actually reaches the user; otherwise fall back to webchat's cron-chat
  // path (no real "cron" channel exists, ownerId stays the tenant stamp).
  const VALID_DELIVER_CHANNELS = ["weixin", "webchat"] as const;
  const deliver = payload.deliver === true;
  const channel =
    deliver &&
    typeof payload.channel === "string" &&
    (VALID_DELIVER_CHANNELS as readonly string[]).includes(payload.channel)
      ? (payload.channel as ChannelId)
      : undefined;
  const chatId = channel && typeof payload.to === "string" && payload.to.length > 0
    ? payload.to
    : `cron:${job.id}`;

  const ctx: InboundMessageContext = {
    channelId: channel ?? "webchat",
    messageId: `cron-${job.id}-${Date.now()}`,
    chatId,
    chatType: "direct",
    senderId: "cron-system",
    content: payload.message,
    timestamp: Date.now(),
    ...(job.ownerId !== undefined ? { webUserId: job.ownerId } : {}),
  };

  await dispatch(ctx);

  return {
    status: "ok",
    summary: payload.message.slice(0, 200),
  };
}