/** The Khronos glTF Validator's npm build (gltf-validator), as these tests use it. */
declare module 'gltf-validator' {
  export interface Issue {
    readonly code: string;
    readonly message: string;
    readonly severity: number;
    readonly pointer?: string;
  }
  export interface Report {
    readonly validatorVersion: string;
    readonly issues: {
      readonly numErrors: number;
      readonly numWarnings: number;
      readonly numInfos: number;
      readonly numHints: number;
      readonly messages: readonly Issue[];
    };
    readonly info?: Record<string, unknown>;
  }
  export function validateBytes(data: Uint8Array, options?: { uri?: string; format?: 'glb' | 'gltf'; maxIssues?: number; writeTimestamp?: boolean; ignoredIssues?: string[] }): Promise<Report>;
  export function version(): string;
}
