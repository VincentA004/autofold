import type { Dispatch, ExecutionTransport } from "./transport"

/** Apply host authority without copying a transport's optional hooks or losing its receiver. */
export function withExecutionDeadline<T extends ExecutionTransport>(transport: T, deadlineMs: number): T {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Execution deadline must be an absolute positive integer timestamp")
  const bounded = (input: Dispatch, launch: boolean): Dispatch => {
    const ceiling = Math.min(deadlineMs, input.authorizationDeadlineMs ?? deadlineMs)
    const check = () => {
      input.signal?.throwIfAborted()
      if (Date.now() >= ceiling) throw new Error("Original process authorization deadline expired")
    }
    if (launch) check()
    return {...input, authorizationDeadlineMs: ceiling,
      // Receipt-only observation deliberately has no launch callback. Keep it absent.
      authorizeStart: launch || input.authorizeStart ? async () => {
        check()
        await input.authorizeStart?.()
        check()
      } : undefined}
  }
  const overrides = {
    dispatch: async (input: Dispatch) => transport.dispatch(bounded(input, true)),
    ...(transport.preflight ? {preflight: async (input: Dispatch) => transport.preflight!(bounded(input, true))} : {}),
    // Expiry closes launch authority, not access to an existing terminal receipt.
    ...(transport.reconcile ? {reconcile: async (input: Dispatch) => transport.reconcile!(bounded(input, false))} : {}),
  }
  // A separate proxy target also permits frozen transports with non-configurable methods.
  return new Proxy(Object.create(null), {get(_target, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key)
    const value = Reflect.get(transport, key, transport)
    return typeof value === "function" ? value.bind(transport) : value
  }}) as T
}
