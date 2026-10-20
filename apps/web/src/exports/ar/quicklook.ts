import type { ArScale } from '../api';

/** Whether this browser opens `<a rel="ar">` in AR Quick Look: iOS and iPadOS Safari (Apple's own test). */
export function quickLook(): boolean {
  try {
    return document.createElement('a').relList.supports('ar');
  } catch {
    return false;
  }
}

/** The fragment AR Quick Look reads (FLR-T-14.3): at true scale, no pinching it smaller — 1:1 stays 1:1. */
export const arFragment = (scale: ArScale): string => (scale === 'true' ? '#allowsContentScaling=0' : '');
