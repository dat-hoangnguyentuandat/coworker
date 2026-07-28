import { AsyncLocalStorage } from "node:async_hooks";

const executionContext = new AsyncLocalStorage();

export function runInExecutionContext(context, callback) {
  return executionContext.run(context, callback);
}

export function currentExecutionContext() {
  return executionContext.getStore();
}

export function activeWorkspaceRoot(fallback) {
  return executionContext.getStore()?.workspace?.root ?? fallback;
}

export function activeDataPath(fallback) {
  return executionContext.getStore()?.dataPath ?? fallback;
}

export function activeTaskId() {
  return executionContext.getStore()?.task?.id ?? "";
}
