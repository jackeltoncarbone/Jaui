# API Examples

What Jwift code looks like when you use it. These are the target API — implement toward this.

## Vanilla TypeScript

```typescript
import { Canvas, Panel, Text, HStack, Spring } from 'jwift';

const canvas = new Canvas(document.getElementById('app')!);

const toolbar = new Panel({
  Style: {
    Material: 'LiquidGlass',
    BorderRadius: '1.5em',
    Padding: '0.5em',
    LiquidBrightness: 1.7,
  },
  Layout: {
    Direction: 'row',
    Align: 'center',
    Gap: '0.75em',
  },
  Children: [
    new Text({ Content: 'Library', Weight: 600, Size: '1.0625em' }),
    new Panel({
      Style: { Material: 'LiquidGlass', BorderRadius: '50%', Width: '3em', Height: '3em' },
      Children: [new Text({ Content: '<', Weight: 600 })],
      OnTap: () => history.back(),
    }),
  ],
});

canvas.Root.AddChild(toolbar);
canvas.Start();
```

## Angular (Jwift.Angular) + JSS

The template is clean markup. The style lives in a `.jss` file.

**Toolbar.Component.ts**
```typescript
@Component({
  selector: 'toolbar',
  styleUrl: './Toolbar.jss',
  template: `
    <jwift-canvas>
      <panel class="Toolbar">
        <panel class="BackButton" (Tap)="GoBack()">
          <text class="Glyph">chevron.left</text>
        </panel>
        <text class="Title">{{ PageTitle() }}</text>
        <panel class="Avatar" (Tap)="OpenProfile()">
          <image [Src]="AvatarUrl()" />
        </panel>
      </panel>
    </jwift-canvas>
  `,
})
```

**Toolbar.jss**
```jss
@style GlassPill {
  Material: LiquidGlass
  LiquidBrightness: 1.7
  BorderColor: rgba(255, 255, 255, 0.4)
  BorderWidth: 0.1em
}

@style Interactive {
  Cursor: Pointer
  @spring Transform { Stiffness: 200, Damping: 28 }

  :Hover { Transform: Scale(1.06) }
  :Active { Transform: Scale(0.92) }
}

.Toolbar : GlassPill {
  Direction: Row
  Align: Center
  Gap: 0.75em
  BorderRadius: 100em
  Padding: 0.5em
}

.BackButton : GlassPill, Interactive {
  Width: 3em
  Height: 3em
  BorderRadius: 50%
}

.Title {
  FontWeight: 600
  FontSize: 1.0625em
  Color: white
}

.Avatar : Interactive {
  Width: 3em
  Height: 3em
  BorderRadius: 50%
  Overflow: Hidden
}
```

## Spring Animation

```typescript
const panel = new Panel({ Style: { Width: '10em', Height: '3em' } });

// Spring-animate to new size — no CSS, no DOM, just physics
panel.Animate('Width', '20em', { Stiffness: 170, Damping: 26 });

// Or snap instantly
panel.Style.Width = '20em';
```

## Progressive Blur (single shader)

```typescript
import { BlurGradient } from 'jwift';

// One node, one shader pass — replaces 7 stacked DOM layers
const topBlur = new BlurGradient({
  Direction: 'to bottom',
  Strength: '60px',
  Feather: '250px',
});

canvas.Root.AddChild(topBlur);
```

## Scroll Container

```typescript
import { ScrollView, Panel, Text } from 'jwift';

const list = new ScrollView({
  Style: { Width: '100%', Height: '100%' },
  // Spring physics — momentum, rubber-band overscroll
  SpringConfig: { Stiffness: 120, Damping: 20 },
});

for (let i = 0; i < 100; i++) {
  list.AddChild(new Panel({
    Style: { Height: '4em', Padding: '1em' },
    Children: [new Text({ Content: `Item ${i}` })],
  }));
}
```

## Superellipse SDF (in GLSL)

```glsl
// Fragment shader — the shape primitive for everything
float SuperellipseSDF(vec2 p, vec2 size, float radius, float smoothness) {
    vec2 d = abs(p) - size + radius;
    float n = 2.0 / smoothness;
    float outer = pow(pow(max(d.x, 0.0), n) + pow(max(d.y, 0.0), n), 1.0 / n) - radius;
    float inner = min(max(d.x, d.y), 0.0);
    return outer + inner;
}

// Use it for clip, border, shadow — all in one pass
float dist = SuperellipseSDF(uv, panelSize, borderRadius, 0.6);
float border = smoothstep(0.0, borderWidth, abs(dist));
float shadow = smoothstep(0.0, shadowBlur, dist);
float clip = smoothstep(0.5, -0.5, dist);  // antialiased clip
```

## Concentric Radius (automatic)

```typescript
const outer = new Panel({
  Style: { BorderRadius: '4.5em', Padding: '1.875em' },
  Children: [
    new Panel({
      // Jwift computes: 4.5 - 1.875 = 2.625em automatically
      Style: { BorderRadius: 'concentric' },
    }),
  ],
});
```
