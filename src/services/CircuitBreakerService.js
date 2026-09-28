const CircuitBreaker = require('opossum');

// Per-call budget for every wrapped provider operation. Exported so callers
// that set their own inner timeout (DaddyLive's schedule fetch) can stay
// safely BELOW it, instead of silently exceeding it and being cut short.
const BREAKER_TIMEOUT_MS = 20000;

class CircuitBreakerService {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Wraps an async function in a circuit breaker.
   * If the function fails 3 times, the breaker opens and trips immediately
   * for the next 5 minutes without hitting the actual endpoint.
   */
  wrap(name, asyncFunction) {
    if (this.breakers.has(name)) {
      return this.breakers.get(name);
    }

    const options = {
      timeout: BREAKER_TIMEOUT_MS, // If function takes longer than this, trigger a failure
      errorThresholdPercentage: 50, // When 50% of requests fail, trip the circuit
      // Was 5 minutes. That made a short upstream wobble blackout a provider for
      // the full window even after it recovered (reproduced: 3 failures -> 0 real
      // calls attempted for 5 min). Still protective, far less user-hostile.
      resetTimeout: 90 * 1000, // After 90s, try again
      // Was 3. With only 3 samples required, two transient 5xx replies in a burst
      // were enough to trip. Requiring more evidence avoids spurious blackouts.
      volumeThreshold: 5 // Wait for at least 5 failures before tripping
    };

    const breaker = new CircuitBreaker(asyncFunction, options);
    
    breaker.fallback((err) => {
      const reason = err ? err.message : 'Unknown';
      console.warn(`[CircuitBreaker] ${name} Fallback triggered. Reason: ${reason}`);
      return null;
    });

    breaker.on('open', () => console.warn(`[CircuitBreaker] ${name} TRIPPED OPEN.`));
    breaker.on('halfOpen', () => console.info(`[CircuitBreaker] ${name} HALF-OPEN. Testing recovery.`));
    breaker.on('close', () => console.info(`[CircuitBreaker] ${name} CLOSED. Fully recovered.`));

    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Snapshot of every breaker's state, for /health and diagnostics.
   * A tripped breaker is the single most confusing failure mode in this addon:
   * the provider looks "down" for minutes while the upstream is actually fine.
   * Exposing it lets an operator tell that apart from a real outage instantly.
   */
  getStatus() {
    const out = {};
    for (const [name, breaker] of this.breakers) {
      let state = 'closed';
      if (breaker.opened) state = 'open';
      else if (breaker.halfOpen) state = 'halfOpen';
      out[name] = {
        state,
        failures: breaker.stats ? breaker.stats.failures : undefined,
        successes: breaker.stats ? breaker.stats.successes : undefined,
        fallbacks: breaker.stats ? breaker.stats.fallbacks : undefined
      };
    }
    return out;
  }

  /** Names of currently tripped breakers (empty when everything is healthy). */
  getOpenBreakers() {
    const open = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.opened) open.push(name);
    }
    return open;
  }
}

module.exports = CircuitBreakerService;
module.exports.BREAKER_TIMEOUT_MS = BREAKER_TIMEOUT_MS;
