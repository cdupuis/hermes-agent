import { isTimeoutError } from '@/lib/with-timeout'

// Consecutive STALLED automatic dials (a pool-slot wait or the 20s dial
// timeout, never a fast transport error) before a secondary parks. A
// tile-pinned scope stays wantOpen for the tile's lifetime, so an owner
// backend that keeps losing its slot wait otherwise re-queues a background
// spawn on every backoff tick forever — the queue/timeout treadmill in
// #103375. Fast failures (a gateway restarting, ECONNREFUSED) keep the
// ordinary unbounded backoff: they cost nothing and the socket must come back
// on its own. Parking keeps the entry; any explicit open of the scope
// (requestGatewayForAgent, openGatewayForAgent, ensureGatewayForAgent,
// ensureActiveGatewayOpen) re-arms it with a fresh budget.
export const SECONDARY_STALLED_DIAL_BUDGET = 3

export function isStalledDialError(error: unknown): boolean {
  if (isTimeoutError(error)) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error ?? '')

  return message.includes('timed out while waiting for a free slot')
}
