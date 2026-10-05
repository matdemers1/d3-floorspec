/** The agent eval (FLR-T-2.9): the tasks, the scorer and the harness that runs Claude through the MCP tools. */
export const PACKAGE_NAME = '@d3-floorspec/agent-eval';

export * from './types.js';
export { score, scoreMeasured, answerLine, judgeAnswer } from './scorer.js';
export { measure } from './measure.js';
export { loadTasks, promptFor } from './tasks.js';
export { seedDocument, seedBatches, documentToBatch } from './seeds.js';
