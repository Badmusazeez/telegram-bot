import { classifyRpcError, type RpcIssue } from "./rpcHealth";

export type MintRpcIssueHandler = (issue: RpcIssue) => Promise<void>;

let handler: MintRpcIssueHandler | null = null;

export function setMintRpcIssueHandler(h: MintRpcIssueHandler | null): void {
  handler = h;
}

/** Fire Telegram alert when Chainstack (mint) RPC is rate-limited / full. */
export async function reportMintRpcIssue(err: unknown): Promise<void> {
  const issue = classifyRpcError(err);
  if (!issue || !handler) return;
  try {
    await handler(issue);
  } catch (e) {
    console.warn(
      `[mint-rpc] alert handler failed: ${e instanceof Error ? e.message : e}`
    );
  }
}
