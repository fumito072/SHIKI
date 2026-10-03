import type { LiveSignals } from './engine/types';

/** Control window ⇄ output windows. Same origin, so BroadcastChannel is enough. */
export const CHANNEL = 'shiki-v1';

export type BridgeMessage =
  /** Sent by the control window every frame. */
  | { t: 'state'; workId: string | null; knobs: number[]; signals: LiveSignals; exposure: number }
  /** Sent by an output window when it opens or reloads. */
  | { t: 'hello' }
  /** Sent by an output window about once a second. */
  | { t: 'alive'; fps: number; width: number; height: number };

export function openBridge(onMessage: (m: BridgeMessage) => void): { send(m: BridgeMessage): void; close(): void } {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<BridgeMessage>) => onMessage(e.data);
  return {
    send: (m) => ch.postMessage(m),
    close: () => ch.close(),
  };
}
