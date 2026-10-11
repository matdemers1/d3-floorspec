/**
 * Whether this browser can path-trace a still on its GPU (FLR-T-13.13): WebGPU, with a hardware
 * adapter. A fallback adapter — a software rasterizer such as SwiftShader, which headless Chromium
 * offers — is no GPU to path-trace on: the server's still is quicker. Small and free of GPU
 * libraries, so the editor can ask before it loads any.
 */

interface AdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}
interface GpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<{ readonly info?: AdapterInfo | undefined; readonly isFallbackAdapter?: boolean } | null | undefined>;
}

/** The GPU's name as the browser gives it ("apple m4-pro"), or null where there is no usable WebGPU. */
export async function webGpuDevice(): Promise<string | null> {
  const gpu = (navigator as unknown as { gpu?: GpuLike | null }).gpu;
  if (gpu === undefined || gpu === null) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (adapter === null || adapter === undefined) return null;
  const info: AdapterInfo = adapter.info ?? {};
  if (info.isFallbackAdapter === true || adapter.isFallbackAdapter === true || info.architecture === 'swiftshader') return null;
  const name = [info.vendor, info.architecture].filter((s) => s !== undefined && s !== '').join(' ');
  return name !== '' ? name : info.description !== undefined && info.description !== '' ? info.description : 'WebGPU';
}
