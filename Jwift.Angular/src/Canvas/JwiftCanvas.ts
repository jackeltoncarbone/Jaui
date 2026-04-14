import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Canvas, type Stylesheet } from 'jwift';
import { JssRegistry, JSS_REGISTRY } from '../Jss/Jss.Registry';
import { PARENT_JIV } from '../Jiv/Parent.Jiv.Token';

/**
 * `<jwift-canvas>` — the Jwift canvas at the app shell. Provides the root
 * Jiv (via PARENT_JIV) and a JssRegistry to all descendant components.
 * Anything declared inside renders into this canvas.
 *
 * Init ordering: descendants need `canvas.Root` at construction time, but
 * Root only exists after the `<canvas>` element renders + Jwift's Canvas
 * boots. We delay projection of `<ng-content>` behind an `@if (Ready())`
 * gate — children only construct after Root exists, so the PARENT_JIV
 * factory runs against a live Jiv.
 *
 * Inputs:
 *   stylesheet — pre-parsed Stylesheet (e.g. from CompileJss('foo.jss'))
 *
 * Outputs:
 *   ready — emits the live Canvas instance once initialized
 */
@Component({
  selector: 'jwift-canvas',
  standalone: true,
  template: `
    <canvas #el style="width:100%;height:100%;display:block"></canvas>
    @if (Ready()) {
      <ng-content></ng-content>
    }
  `,
  styles: [':host { display: block; width: 100%; height: 100%; position: relative; }'],
  providers: [
    JssRegistry,
    { provide: JSS_REGISTRY, useExisting: JssRegistry },
    {
      provide: PARENT_JIV,
      // Children only resolve this after `Ready()` flips → Canvas is live.
      useFactory: (canvas: JwiftCanvas) => canvas.Canvas!.Root,
      deps: [JwiftCanvas],
    },
  ],
})
export class JwiftCanvas implements AfterViewInit, OnDestroy {
  @ViewChild('el', { static: true }) ElementRef!: ElementRef<HTMLCanvasElement>;

  readonly stylesheet = input<Stylesheet | undefined>(undefined);
  readonly ready = output<Canvas>();

  Canvas?: Canvas;
  readonly Ready = signal(false);

  private _registry = inject(JssRegistry);

  ngAfterViewInit(): void {
    this.Canvas = new Canvas(this.ElementRef.nativeElement);
    const sheet = this.stylesheet();
    if (sheet) this._registry.Merge(sheet);
    this.Canvas.Start();
    this.Ready.set(true);
    this.ready.emit(this.Canvas);
  }

  ngOnDestroy(): void {
    this.Canvas = undefined;
  }
}
