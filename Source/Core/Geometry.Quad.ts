/**
 * Unit quad VAO. Every Jiv is rendered by binding this and
 * transforming it to the panel's rect via uniforms.
 *
 * Two triangles covering [0,0] to [1,1]:
 *   0--1
 *   |/ |
 *   2--3
 */
export class QuadGeometry {
  readonly Vao: WebGLVertexArrayObject;

  private static readonly _POSITIONS = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ]);

  private static readonly _INDICES = new Uint16Array([
    0, 1, 2,
    2, 1, 3,
  ]);

  constructor(gl: WebGL2RenderingContext) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('[Jaui] Failed to create VAO');
    this.Vao = vao;

    gl.bindVertexArray(vao);

    // Position buffer — attribute 0
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QuadGeometry._POSITIONS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Index buffer
    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QuadGeometry._INDICES, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  Bind = (gl: WebGL2RenderingContext): void => {
    gl.bindVertexArray(this.Vao);
  };

  Draw = (gl: WebGL2RenderingContext): void => {
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
}
