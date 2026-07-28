import { z } from "zod";
import { currentExecutionContext } from "./execution-context.js";
import { result } from "./workspace-tools.js";

export function registerTaskDispatchTools(server, { mailbox, onChange }) {
  server.registerTool("task_dispatch", {
    title: "Coordinate a task between ChatGPT conversations",
    description: "Create a durable mailbox message for another task in the same workspace. This cannot wake or create a ChatGPT Web turn; the owner must resume the target conversation and have it claim the message.",
    inputSchema: {
      action: z.enum(["list", "send", "claim", "complete", "fail"]),
      to_task_id: z.string().optional(),
      message_id: z.string().optional(),
      prompt: z.string().max(10000).optional(),
      response: z.string().max(5000).optional()
    }
  }, async args => {
    const taskId = currentExecutionContext()?.task?.id;
    if (!taskId) return result("No task is bound to this MCP call.", true);
    try {
      let output;
      if (args.action === "list") output = mailbox.list(taskId);
      else if (args.action === "send") {
        if (!args.to_task_id || !args.prompt?.trim()) throw new Error("to_task_id and prompt are required for send.");
        output = await mailbox.send(taskId, args.to_task_id, args.prompt);
      } else if (args.action === "claim") {
        if (!args.message_id) throw new Error("message_id is required for claim.");
        output = await mailbox.claim(taskId, args.message_id);
      } else {
        if (!args.message_id) throw new Error("message_id is required to complete or fail a dispatch.");
        output = await mailbox.finish(taskId, args.message_id, args.action === "complete" ? "completed" : "failed", args.response || "");
      }
      onChange?.();
      return result(JSON.stringify(output, null, 2));
    } catch (error) { return result(error.message, true); }
  });
}
