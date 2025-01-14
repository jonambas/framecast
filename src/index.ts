import superjson from 'superjson';

/**
 * Config for the framecast
 */
export type FramecastConfig = {
  origin: string | null;
  channel: string | null;
  self: Window | null;
  functionTimeoutMs: number;
  supportEvaluate: boolean;
};

/**
 * Listener for broadcasts
 */
export type BroadcastEventListener = (this: Framecast, message: any) => void;

/**
 * Listener for function calls
 */
export type FunctionEventListener = (
  this: Framecast,
  ...args: any[]
) => Promise<any>;

/**
 * Map of the event keys and their listeners in a Set
 */
type ListenerMap = {
  broadcast: Set<BroadcastEventListener>;
  [event: `function:${string}`]: Set<FunctionEventListener>;
};

export class Framecast {
  /**
   * The element we are communicating with.
   */
  private target: Window;

  /**
   * Config for the framecast.
   */
  private config: FramecastConfig = {
    origin: null,
    channel: null,
    self: null,
    functionTimeoutMs: 10000,
    supportEvaluate: false,
  };

  /**
   * Listeners for messages and function calls
   */
  private listeners: ListenerMap = { broadcast: new Set() };

  /**
   * Map of pending function calls
   */
  private pendingFunctionCalls: Map<
    number,
    { timeout: number; resolve: Function; reject: Function }
  > = new Map();

  constructor(target: Window, config?: Partial<FramecastConfig>) {
    if (!target) {
      throw new Error(`Framecast must be initialized with a window object`);
    }

    this.target = target;
    this.config = { ...this.config, ...config };
    this.self.removeEventListener(
      'message',
      this.handlePostedMessage.bind(this)
    );
    this.self.addEventListener('message', this.handlePostedMessage.bind(this));

    if (this.config.supportEvaluate) {
      this.on('function:evaluate', async (fn: string) => {
        return eval(fn);
      });
    }
  }

  /**
   * Get the origin of the target
   */
  get origin(): string {
    return this.config.origin ?? '*';
  }

  /**
   * Get the channel identifier
   */
  get channel(): string {
    return `__framecast${this.config.channel ? `_${this.config.channel}` : ''}`;
  }

  /**
   * Get the current window
   */
  get self(): Window {
    return this.config.self ?? window;
  }

  private postMessage(type: string, message: any) {
    this.target.postMessage(
      superjson.stringify({ ...message, type, channel: this.channel }),
      this.origin
    );
  }

  /**
   * Adds a listener for a given event.
   * @param eventType Event type.
   * @param listener Listener function.
   */
  on(eventType: keyof ListenerMap, listener: Function): void {
    if (!this.listeners[eventType]) {
      this.listeners[eventType] = new Set() as any;
    }

    // only allow one listener per function
    if (
      eventType.startsWith('function:') &&
      this.listeners[eventType].size !== 0
    ) {
      throw new Error(`Listener already exists for ${eventType}`);
    }

    this.listeners[eventType].add(listener as any);
  }

  /**
   * Removes a listener for a given event.
   * @param eventType Event type.
   * @param listener Listener function.
   */
  off(eventType: keyof ListenerMap, listener: Function): void {
    if (this.listeners[eventType]) {
      this.listeners[eventType].delete(listener as any);
    }
  }

  /**
   * Sends an message
   *
   * Lifecycle
   * -----
   * self: broadcast() --->
   * target: handlePostedMessage() -> handleBroadcast()
   * @param data Message to send.
   */
  broadcast(data: any): void {
    this.postMessage('broadcast', { data });
  }

  /**
   * Calls a remote function and returns the result
   *
   * If we don't have a response within {this.config.functionTimeoutMs} seconds, we'll throw an error.
   *
   * Lifecycle
   * -----
   * self: call(): Promise --->
   * target: handlePostedMessage() -> handleFunctionCall() --->
   * self: handleFunctionResult() -> resolve/reject the original promise -> clearPendingFunctionCall()
   *
   * @param functionName The name of the function to call.
   * @param args Arguments to pass to the function.
   * @returns The result of the function.
   */
  async call<ReturnValue = any>(
    functionName: string,
    ...args: any[]
  ): Promise<ReturnValue> {
    const id = Date.now();

    if (!this.config.functionTimeoutMs) {
      throw new Error(
        `Framecast.call() requires a config.functionTimeoutMs to be set`
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.clearPendingFunctionCall(id);
        reject(
          new Error(
            `${functionName} timed out after ${this.config.functionTimeoutMs}ms`
          )
        );
      }, this.config.functionTimeoutMs);
      this.pendingFunctionCalls.set(id, { timeout, resolve, reject });
      this.postMessage(`function:${functionName}`, { id, args });
    });
  }

  /**
   * Evaluates the given function in the context of the target window
   * and returns the result.
   *
   * Note: the target window must have the `supportEvaluate` option set to true
   *
   * Pass in additional arguments to the evaluate function by passing them as additional arguments to this function.
   *
   * The arguments must be serializable using JSON.stringify
   */
  async evaluate<ReturnValue = any>(
    fn: (...args: any[]) => ReturnValue,
    ...args: any[]
  ): Promise<ReturnValue> {
    const fnString = fn.toString();
    const argsString = args.map((a) => JSON.stringify(a)).join(',');
    const calledFnString = `(${fnString})(${argsString})`;

    return this.call('evaluate', calledFnString);
  }

  /**
   * Handles the raw messages posted to the window
   * @param event The event that was posted to the window
   */
  private async handlePostedMessage(event: MessageEvent) {
    try {
      const data = superjson.parse(event.data) as any;
      if (this.origin !== '*' && event.origin !== this.origin) {
        // Origin did not match target
        return;
      }

      if (this.channel !== data.channel) {
        // Channel did not match target
        return;
      }

      if (data.type === 'broadcast') {
        this.handleBroadcast(data.data);
      } else if (data.type === 'functionResult') {
        this.handleFunctionResult(data);
      } else if (data.type.startsWith('function:')) {
        this.handleFunctionCall(data.type, data.id, data.args);
      } else {
        // Unknown message type
      }
    } catch (error) {
      // could not handle message
    }
  }

  /**
   * Emit a broadcast to the listeners
   * @param data
   */
  private async handleBroadcast(data: any) {
    for (const listener of this.listeners['broadcast'] ?? []) {
      (listener as Function).apply(this, [data]);
    }
  }

  /**
   * Emit a function call to the listeners and return the result or error
   * @param eventType Event type.
   * @param args Arguments to pass to the listener.
   */
  private async handleFunctionCall(
    eventType: keyof ListenerMap,
    id: number,
    args: any[]
  ) {
    if (!this.listeners[eventType] || this.listeners[eventType].size === 0) {
      this.postMessage('functionResult', {
        id,
        error: new Error(`No listeners for ${eventType}`),
      });
      return;
    }

    try {
      let result;
      for (const listener of this.listeners[eventType] ?? []) {
        result = await (listener as Function).apply(this, args);
      }
      this.postMessage('functionResult', { id, result });
    } catch (error) {
      // `Error calling function, sending back error
      this.postMessage('functionResult', { id, error });
      return;
    }
  }

  /**
   * Recieve a function result and resolve or reject the pending function call
   */
  private async handleFunctionResult(data: {
    type: 'functionResult';
    id: number;
    result?: any;
    error?: Error;
  }) {
    const pendingCall = this.pendingFunctionCalls.get(data.id);
    if (pendingCall) {
      // Received function result
      this.clearPendingFunctionCall(data.id);
      if (data.error) {
        pendingCall.reject(data.error);
      } else {
        pendingCall.resolve(data.result);
      }
    } else {
      // Received function result for unknown id
    }
  }

  /**
   * Clears a pending function call
   * @param id The id of the pending function call
   */
  private clearPendingFunctionCall(id: number) {
    const pendingCall = this.pendingFunctionCalls.get(id);
    if (pendingCall) {
      this.pendingFunctionCalls.delete(id);
      clearTimeout(pendingCall.timeout);
    }
  }
}
