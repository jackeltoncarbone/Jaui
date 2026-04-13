export interface TextDrawCommand {
  Texture: WebGLTexture;
  X: number;         // device pixels
  Y: number;
  Width: number;
  Height: number;
  Opacity: number;
}

export class TextInstanceBuffer {
  private _commands: TextDrawCommand[] = [];

  get Commands(): readonly TextDrawCommand[] { return this._commands; }
  get Count(): number { return this._commands.length; }

  Begin = (): void => {
    this._commands.length = 0;
  };

  Push = (cmd: TextDrawCommand): void => {
    this._commands.push(cmd);
  };
}
