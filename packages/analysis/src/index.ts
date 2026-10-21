/**
 * @floorspec/analysis — the advisory energy and comfort estimate of a Floorspec document
 * (FLR-REQ-153, FLR-T-12.6). It reads the engine's evaluation and never changes a document; its
 * inputs live in the document's extras and change through Ops like anything else. Isomorphic
 * (FLR-ADR-010) and deterministic. Advisory, always: an estimate to compare options, never an
 * energy-code calculation and never a statement that a house meets a code (FLR-ADR-011's spirit).
 *
 * **The thermal envelope (FLR-T-16.4), for what builds on it** — FLR-T-16.5 (what if), FLR-T-16.6 (sizing
 * equipment against room loads) and FLR-T-16.9 (the off-grid dashboard):
 *
 * - `estimateEnergy(document, { design?, inputs?, compare? })` → `EnergyEstimate`. Beside 12.6's `loads`,
 *   `assemblies`, `facades`, `notes` and `options`, it carries `rooms: RoomLoad[]` (each conditioned room's
 *   `heating` and `cooling` in W, `heatingParts` / `coolingParts` by `PartKind`, `coolingHour`, `perArea`
 *   Btu/h·ft² and its `band`), `surfaces: SurfaceLoss[]` (each envelope wall, window, door and roof: `u`,
 *   `area`, `flux` W/m² on the design day, `band`), `shares` (the heating load by what it goes through),
 *   `thermal` (the plan uses FS_thermal) and `envelope: AssemblyThermal[]`. Every W is a point value: show
 *   it with `range()` / `loadRange()` (±20%, two significant figures) and name `ROOM_METHOD`.
 * - Room loads at other conditions: `RoomLoad.heating` is UA × (indoorWinter − heatingDesign), so a
 *   room's UA is `heating / (climate.indoorWinter − climate.heatingDesign)`; cooling parts are at
 *   (coolingDesign − indoorSummer) plus sun and internal gains. 16.6 sizes a head per room from
 *   `heating` and `cooling` (with its own margin, said so); 16.9 sums `loads.annualHeating` /
 *   `annualCooling` (kWh) by month from degree days.
 * - What if (16.5): change the document (a layer's material, a type's `uFactor`/`shgc`, a material's
 *   `solarReflectance`) and call `estimateEnergy` again — it is pure and deterministic; compare
 *   `loads`, `rooms` and `surfaces`. `wallTypeThermal(thermalView(doc), typeId)`, `roofThermal`,
 *   `floorThermal` give one assembly's R and U layer by layer without the whole estimate.
 * - `resolveClimate(inputs, latitude, longitude)` → the user's zone, else the nearest `STATIONS` entry
 *   within `STATION_RANGE_KM`, else the 4A preset, assumed; `Climate.source` says which.
 * - Thermal values: `THERMAL_LIBRARY` (CC0), `thermalMatch(materialId, material)`, `thermalData(item)` —
 *   FS_thermal 0.1.0 data with its citation, ready to write onto a material.
 */
export * from './climate.js';
export * from './solar.js';
export * from './envelope.js';
export * from './inputs.js';
export * from './estimate.js';
export * from './format.js';
export * from './daylight.js';
export * from './pv.js';
export * from './thermal-library.js';
export * from './assemblies.js';
export * from './rooms.js';
