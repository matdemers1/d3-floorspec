#!/usr/bin/env node
import { PACKAGE_NAME } from './index.js';

// `floorspec validate` and friends arrive with the engine; until then the binary only says what it is.
process.stdout.write(`${PACKAGE_NAME} 0.1.0 — no commands yet\n`);
