/** The room-centric summary Claude reads over MCP (FLR-T-2.7). */
export { describe, summaryText } from './text.js';
export {
  describeJson,
  sideOf,
  SIDES,
  type DescribeOptions,
  type DiagnosticSummary,
  type DocumentSummary,
  type EdgeSummary,
  type ElementSummary,
  type CirculationSummary,
  type ProgramSummary,
  type ProgramItemSummary,
  type ProgramAdjacencySummary,
  type FaceSummary,
  type LevelSummary,
  type Link,
  type Neighbour,
  type OpeningSummary,
  type RoomSummary,
  type Side,
} from './summary.js';
export { feetInches, inches, squareFeet, segmentLength, lengthText, type Length } from './units.js';
