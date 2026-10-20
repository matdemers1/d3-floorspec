import { basisOf, type Look } from './view';

/**
 * An equirectangular panorama drawn by one fragment shader over the whole canvas (FLR-T-14.2): each
 * pixel's line of sight, turned into a yaw and a pitch, read from the panorama exactly as the worker
 * wrote it (@floorspec/mesh tour.ts — its middle column north, its top row straight up). No mipmaps,
 * so the seam where the yaw wraps never shows; a phone sees a quarter of the panorama's width across
 * its screen, so none are needed.
 */

const VERTEX = `
attribute vec2 a;
varying vec2 ndc;
void main() { ndc = a; gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
varying vec2 ndc;
uniform sampler2D pano;
uniform vec3 forward;
uniform vec3 right;
uniform vec3 up;
uniform vec2 tan2;
const float PI = 3.141592653589793;
void main() {
  vec3 d = normalize(forward + ndc.x * tan2.x * right + ndc.y * tan2.y * up);
  float yaw = atan(d.x, d.y);
  float pitch = asin(clamp(d.z, -1.0, 1.0));
  vec2 uv = vec2(fract(yaw / (2.0 * PI) + 0.5), 0.5 - pitch / PI);
  gl_FragColor = texture2D(pano, uv);
}
`;

export class Panorama {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private readonly loc: { forward: WebGLUniformLocation | null; right: WebGLUniformLocation | null; up: WebGLUniformLocation | null; tan2: WebGLUniformLocation | null };

  /** Null where the browser has no WebGL. */
  static on(canvas: HTMLCanvasElement): Panorama | null {
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    return gl === null ? null : new Panorama(gl);
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (s === null) throw new Error('no shader');
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (gl.getShaderParameter(s, gl.COMPILE_STATUS) !== true) throw new Error(gl.getShaderInfoLog(s) ?? 'the shader did not compile');
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) throw new Error(gl.getProgramInfoLog(program) ?? 'the program did not link');
    this.program = program;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.loc = { forward: gl.getUniformLocation(program, 'forward'), right: gl.getUniformLocation(program, 'right'), up: gl.getUniformLocation(program, 'up'), tan2: gl.getUniformLocation(program, 'tan2') };
  }

  /** The panorama to show: an equirectangular picture, its top row straight up. */
  show(image: HTMLImageElement | ImageBitmap): void {
    const gl = this.gl;
    if (this.texture !== null) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    // Linear, no mipmaps; across the seam the yaw wraps, which WebGL 1 allows a power-of-two picture (every tour's is).
    const pot = (n: number) => n > 0 && (n & (n - 1)) === 0;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, pot(image.width) && pot(image.height) ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(this.program, 'pano'), 0);
  }

  /** Draw the view into a canvas `width` × `height` device pixels. */
  draw(look: Look, width: number, height: number): void {
    const gl = this.gl;
    if (this.texture === null) return;
    gl.viewport(0, 0, width, height);
    const b = basisOf(look);
    const tanY = Math.tan((look.fov * Math.PI) / 360);
    gl.uniform3f(this.loc.forward, b.forward[0], b.forward[1], b.forward[2]);
    gl.uniform3f(this.loc.right, b.right[0], b.right[1], b.right[2]);
    gl.uniform3f(this.loc.up, b.up[0], b.up[1], b.up[2]);
    gl.uniform2f(this.loc.tan2, tanY * (width / Math.max(1, height)), tanY);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The largest picture this device takes. */
  maxSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  dispose(): void {
    if (this.texture !== null) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
