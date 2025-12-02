/**
 * @fileoverview Utility functions for bee-threads.
 * @module bee-threads/utils
 */

'use strict';

/**
 * Recursively freezes an object to prevent mutation.
 * 
 * @param {Object} obj - Object to freeze
 * @returns {Object} Frozen object
 * 
 * @example
 * const frozen = deepFreeze({ a: { b: 1 } });
 * frozen.a.b = 2; // throws in strict mode
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      deepFreeze(obj[key]);
    }
  });
  return Object.freeze(obj);
}

/**
 * Promise-based sleep utility.
 * 
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 * 
 * @example
 * await sleep(1000); // waits 1 second
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculates exponential backoff delay with jitter.
 * 
 * Formula: `min(baseDelay * factor^attempt, maxDelay) ± 25%`
 * 
 * Jitter prevents thundering herd when multiple retries happen simultaneously.
 * 
 * @param {number} attempt - Current attempt (0-indexed)
 * @param {number} baseDelay - Initial delay in ms
 * @param {number} maxDelay - Maximum delay cap in ms
 * @param {number} factor - Exponential factor
 * @returns {number} Delay in milliseconds
 * 
 * @example
 * calculateBackoff(0, 100, 5000, 2); // ~100ms
 * calculateBackoff(1, 100, 5000, 2); // ~200ms
 * calculateBackoff(2, 100, 5000, 2); // ~400ms
 */
function calculateBackoff(attempt, baseDelay, maxDelay, factor) {
  const delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

module.exports = {
  deepFreeze,
  sleep,
  calculateBackoff
};

