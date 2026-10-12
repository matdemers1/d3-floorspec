/**
 * Whether WebGL here is drawn in software — SwiftShader or llvmpipe: a machine with no GPU, or a
 * headless browser. Under a sky (FLR-T-13.4) every pixel of the lawn and every shadow tap then costs
 * real time, so the 3D view draws hard-edged shadows and reads the lawn without anisotropic
 * filtering there; on a GPU it draws soft shadows and a crisp lawn. Asked once, of a canvas of its own.
 */
let known: boolean | null = null;

export function softwareWebGL(): boolean {
  if (known !== null) return known;
  known = false;
  try {
    const ctx = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    if (ctx !== null) {
      const info = ctx.getExtension('WEBGL_debug_renderer_info');
      const name = String(ctx.getParameter(info === null ? ctx.RENDERER : info.UNMASKED_RENDERER_WEBGL));
      known = /swiftshader|llvmpipe|software/i.test(name);
      ctx.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    known = false;
  }
  return known;
}
