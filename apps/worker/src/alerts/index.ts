/** Alert email through the D3 Auth mail relay (FLR-T-12.2): sent by the api and by the worker. */
export {
  createMailer,
  describeRelay,
  redact,
  relayFromEnv,
  urlPassword,
  RELAY_TIMEOUT_MS,
  REPEAT_AFTER_MS,
  type Alert,
  type AlertKind,
  type AlertLedger,
  type Mailer,
  type MailerOptions,
  type MailResult,
  type RelayConfig,
  type SendOptions,
} from './mailer.js';
export { ALERTS } from './catalogue.js';
export { pgAlertLedger } from './ledger.js';
export { createWatchdog, httpProbe, pgProbe, type Probe, type Watchdog, type WatchdogOptions, type WatchdogState } from './watchdog.js';
