import { ShaderCompiler, type ShaderProgram } from '../Core/Shader.Compiler';
import { QuadGeometry } from '../Core/Geometry.Quad';
import type { Jiv } from './Jiv';
import vertSrc from './Shaders/Jiv.Panel.vert?raw';
import fragSrc from './Shaders/Jiv.Panel.frag?raw';

export class JivRenderer {
  private _shader: ShaderProgram;
  private _quad: QuadGeometry;

  constructor(private _gl: WebGL2RenderingContext) {
    this._shader = ShaderCompiler.Compile(_gl, vertSrc, fragSrc);
    this._quad = new QuadGeometry(_gl);
  }

  Render = (jiv: Jiv, canvasWidth: number, canvasHeight: number, dpr: number): void => {
    const gl = this._gl;
    const s = this._shader;
    const style = jiv.Style;
    const d = dpr; // all CSS pixels → device pixels

    gl.useProgram(s.Program);

    // Scale CSS pixel values to device pixels
    const x = jiv.X * d;
    const y = jiv.Y * d;
    const w = jiv.Width * d;
    const h = jiv.Height * d;
    const borderWidth = style.BorderWidth * d;
    const borderBlur = style.BorderBlur * d;
    const shadowBlur = style.ShadowBlur * d;
    const shadowOffX = style.ShadowOffsetX * d;
    const shadowOffY = style.ShadowOffsetY * d;
    const radii: [number, number, number, number] = [
      style.BorderRadius[0] * d, style.BorderRadius[1] * d,
      style.BorderRadius[2] * d, style.BorderRadius[3] * d,
    ];

    // Expand the draw rect to include shadow bleed
    const shadowMarginX = shadowBlur + Math.abs(shadowOffX);
    const shadowMarginY = shadowBlur + Math.abs(shadowOffY);
    const borderMargin = borderWidth + borderBlur;
    const marginX = Math.max(shadowMarginX, borderMargin);
    const marginY = Math.max(shadowMarginY, borderMargin);

    const rectX = x - marginX;
    const rectY = y - marginY;
    const rectW = w + marginX * 2;
    const rectH = h + marginY * 2;

    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const halfW = w / 2;
    const halfH = h / 2;

    // Uniforms (all in device pixels)
    this._uniform2f(s, 'u_Resolution', canvasWidth, canvasHeight);
    this._uniform4f(s, 'u_Rect', rectX, rectY, rectW, rectH);
    this._uniform2f(s, 'u_PanelCenter', centerX, centerY);
    this._uniform2f(s, 'u_PanelHalfSize', halfW, halfH);
    this._uniform4f(s, 'u_Radii', radii[0], radii[1], radii[2], radii[3]);
    this._uniform1f(s, 'u_Smoothness', style.Smoothness);
    this._uniform4f(s, 'u_Background',
      style.Background.R, style.Background.G,
      style.Background.B, style.Background.A,
    );
    this._uniform4f(s, 'u_BorderColor',
      style.BorderColor.R, style.BorderColor.G,
      style.BorderColor.B, style.BorderColor.A,
    );
    this._uniform1f(s, 'u_BorderWidth', borderWidth);
    this._uniform1f(s, 'u_BorderBlur', borderBlur);
    this._uniform4f(s, 'u_ShadowColor',
      style.ShadowColor.R, style.ShadowColor.G,
      style.ShadowColor.B, style.ShadowColor.A,
    );
    this._uniform1f(s, 'u_ShadowBlur', shadowBlur);
    this._uniform2f(s, 'u_ShadowOffset', shadowOffX, shadowOffY);
    this._uniform1f(s, 'u_Opacity', style.Opacity);

    // Draw
    this._quad.Bind(gl);
    this._quad.Draw(gl);
  };

  private _uniform1f = (s: ShaderProgram, name: string, v: number): void => {
    const loc = s.Uniforms.get(name);
    if (loc) this._gl.uniform1f(loc, v);
  };

  private _uniform2f = (s: ShaderProgram, name: string, x: number, y: number): void => {
    const loc = s.Uniforms.get(name);
    if (loc) this._gl.uniform2f(loc, x, y);
  };

  private _uniform4f = (s: ShaderProgram, name: string, x: number, y: number, z: number, w: number): void => {
    const loc = s.Uniforms.get(name);
    if (loc) this._gl.uniform4f(loc, x, y, z, w);
  };
}
