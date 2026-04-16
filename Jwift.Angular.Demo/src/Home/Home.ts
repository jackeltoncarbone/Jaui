import { ChangeDetectionStrategy, Component, HostListener, signal, computed, inject, afterNextRender } from '@angular/core';
import { Jiv, Jext, Jyle, JwiftCanvas } from 'jwift-angular';
import HomeJss from './Home.jss';

/**
 * Show Studio home — Jwift Angular port. First-pass visual skeleton
 * matching the iOS 26 / Liquid Glass design language:
 *
 *   • Dark full-bleed screen
 *   • Hero stub (solid color today, 3D reality view later)
 *   • Featured / Trending / Continue / New-in-Store carousel sections
 *   • Floating Liquid Glass toolbar (top-right)
 *   • Floating Liquid Glass tab bar (bottom-center)
 *   • ProgressiveBlur feather above the tab bar — scrolled content ramps
 *     from crisp at top of the feather to heavy GPU blur at the bottom,
 *     matching Show Studio's native look.
 */

type CardRef = { Kicker: string; Title: string; Color: string };
type SectionData = {
  Title: string;
  Items: CardRef[];
  RowClass: 'Row' | 'RowCompact';
  CardClass: 'Card' | 'CardCompact';
  TitleClass: 'CardTitle' | 'CardTitleCompact';
};

const LOGO_SVG = `<svg version="1.1" viewBox="150 480 900 350" xmlns="http://www.w3.org/2000/svg"><g><g><path fill="#ffffff" d="M316.02,568.08c-13.56-3.75-25.26-6.98-25.26-17.9c0-9.67,6.7-15.44,17.91-15.44c0.32,0,0.64,0.01,0.97,0.01 c12.27,0.34,18.36,7.62,18.96,14.68l0.11,1.36h24.95l-0.13-1.61c-1.78-21.17-18.18-34.32-42.81-34.32 c-26.22,0-43.16,14.14-43.16,36.01c0,25.8,20.36,31.23,38.32,36.02c13.96,3.72,26.03,6.94,26.03,18.91 c0,10.06-7.78,16.3-20.31,16.3c-11.7,0-19.23-6.21-20.14-16.61l-0.12-1.35h-24.12v1.48c0,21.31,18.25,36.19,44.38,36.19 c28.45,0,43.34-18.64,43.34-37.06C354.93,578.83,333.35,572.87,316.02,568.08z"/><polygon fill="#ffffff" points="449.93,568.4 395.88,568.4 395.88,516.43 373.03,516.43 373.03,640.59 395.88,640.59 395.88,587.58 449.93,587.58 449.93,640.59 472.78,640.59 472.78,516.43 449.93,516.43"/><path fill="#ffffff" d="M553.86,514.86c-36.14,0-63.39,27.25-63.39,63.39c0,36.24,27.25,63.56,63.39,63.56 c36.14,0,63.39-27.33,63.39-63.56C617.24,542.11,589.99,514.86,553.86,514.86z M553.86,621.58c-23.94,0-40.02-17.41-40.02-43.33 c0-25.71,16.08-42.98,40.02-42.98c23.94,0,40.02,17.27,40.02,42.98C593.87,604.17,577.79,621.58,553.86,621.58z"/><polygon fill="#ffffff" points="754.03,640.59 790.83,516.43 766.42,516.43 742.29,610.14 718.15,516.43 693.55,516.43 667.53,610.82 643.52,516.43 619.31,516.43 654.5,640.78 679.05,640.58 704.93,552.78 729.3,640.59"/></g><path fill="#FFB600" d="M1023.06,547.2c-2.63-0.19-5.12,0.54-7.17,1.93c-2.03,1.38-3.62,3.43-4.43,5.89 c-4.13,12.47-15.99,35.36-48.87,46.89c-13.11,4.6-29.57,7.4-50.21,7.01h-16.81l-2.95,0.03v-0.38c0.03-2.32,0.03-4.66,0.04-7 c2.8-1.32,6.02-2.44,7.59-5.4c3.68-5.74-0.38-14.5-7.11-15.02c-6.61-0.31-13.21-0.21-19.83-0.01c-6.56,0.05-11.59,8.49-8.08,14.42 c1.36,3.4,4.94,4.58,7.88,6.02c-0.07,2.52-0.07,5.05-0.08,7.55l-39.75,0.35c0-2.66-0.01-5.3-0.04-7.97c2.9-1.36,6.44-2.37,7.78-5.7 c3.79-6.15-1.52-15.04-8.48-14.72c-6.58-0.09-13.2-0.25-19.77,0.11c-6.22,0.98-10.19,8.99-6.86,14.61 c1.42,3.28,4.89,4.38,7.79,5.75c-0.04,2.69,0,5.36,0.01,8.08h-15.11c-5.94,0-10.76,4.82-10.76,10.76c0,5.94,4.82,10.76,10.76,10.76 h96.98h16.54c11.58,0.2,22.04-0.53,31.48-1.97c0.04,0,0.08,0,0.1-0.01c8.68-0.92,17.3-2.79,25.3-6.27 c11.03-3.92,20.08-8.92,27.5-14.31c7.06-5.12,12.62-10.6,16.98-15.84V700.5c-4.38-5.35-9.99-11.1-17.1-16.57 c-3.63-2.79-7.66-5.51-12.12-8.05c-15.39-8.78-35.92-15.51-63.19-16.29c-2.9-0.08-5.88-0.1-8.94-0.04h-16.54v0.04h-71.72 c-36.15,0-81.38-4.58-108.58,25.29c-12.75,14.03-18.25,32.56-16.39,55.22c0.5,3.71,1.28,7.29,2.35,10.75 c0.06,0.3,0.14,0.58,0.24,0.85c9.03,28.95,35.94,49.19,69.05,49.19c0.51,0,1.03,0,1.52-0.03c14.75,0.19,28.88-4.26,40.56-12.69 c0.09-0.04,0.15-0.09,0.19-0.13c18.36-12.67,30.03-33.66,30.03-58.06c0-6-0.7-11.81-2.05-17.31c-1.49-6.1-6.96-10.3-13.08-10.3 c-8.68,0-14.99,8.23-13.21,16.96c1.93,9.51,0.98,19.77-3.45,29.44c-10.97,23.9-38.25,33.71-60.81,22.8 c-3.43-1.65-6.57-3.68-9.41-6.05c-9.76-8.53-16.04-21.2-16.04-35.54c0-13,5.12-24.54,13.36-32.88 c18.31-14.31,42.53-14.13,64.45-13.77v0.01h0.38c13.19,0.21,26.4,0.15,39.59,0.15h53.02v0.06h16.81c1.24-0.01,2.47-0.03,3.69-0.03 c28.76,0,49.1,6.47,63.45,15.3c20.35,12.5,28.66,29.72,31.97,39.93c0.79,2.46,2.36,4.5,4.36,5.89c2.05,1.43,4.55,2.17,7.18,2h0.01 c5.93-0.4,10.54-5.33,10.54-11.27V558.5C1033.57,552.56,1028.99,547.63,1023.06,547.2z"/><g><g><path fill="#FFB600" d="M219.46,721.3c-14.73-4.07-27.45-7.59-27.45-19.45c0-10.51,7.27-16.78,19.46-16.78 c0.35,0,0.7,0.01,1.05,0.02c13.33,0.37,19.95,8.28,20.61,15.96l0.12,1.48h27.11l-0.15-1.75c-1.93-23-19.76-37.29-46.51-37.29 c-28.49,0-46.9,15.36-46.9,39.13c0,28.04,22.12,33.93,41.64,39.14c15.17,4.05,28.28,7.54,28.28,20.55 c0,10.93-8.46,17.71-22.07,17.71c-12.72,0-20.9-6.75-21.89-18.04l-0.13-1.47h-26.21v1.61c0,23.15,19.83,39.32,48.22,39.32 c30.91,0,47.09-20.26,47.09-40.27C261.74,732.99,238.3,726.51,219.46,721.3z"/><polygon fill="#FFB600" points="268.22,686.03 303.46,686.03 303.46,800.1 328.29,800.1 328.29,686.03 363.34,686.03 363.34,665.19 268.22,665.19"/><path fill="#FFB600" d="M460.85,750.74c0,18.65-9.79,28.51-28.32,28.51c-18.41,0-28.13-9.86-28.13-28.51v-85.55h-24.83v85.17 c0,31.02,20.71,51.07,52.77,51.07c24.6,0,53.34-13.37,53.34-51.07v-85.17h-24.83V750.74z"/><path fill="#FFB600" d="M556.69,665.19h-44.62V800.1h44.62c21.28,0,39.22-6.2,51.9-17.91c12.85-11.87,19.64-28.84,19.64-49.08 C628.23,691.85,600.15,665.19,556.69,665.19z M556.69,779.25h-19.79v-93.22h19.79c29.32,0,46.14,17.16,46.14,47.08 C602.83,762.86,586.44,779.25,556.69,779.25z"/><rect x="651.71" y="665.19" fill="#FFB600" width="24.83" height="134.91"/></g></g></g></svg>`;

@Component({
  selector: 'home',
  standalone: true,
  imports: [Jiv, Jext, Jyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <jyle [source]="JssSource" />

    <jiv class="Screen">

      <!-- Progressive-blur feathers sit at Screen edges, under the chrome -->
      <jiv class="TopBlur" />
      <jiv class="ContentBlur" />

      <!-- Chrome frame — one uniformly-padded container. Toolbar pinned to
           its top, TabBar pinned to its bottom via Justify: SpaceBetween.
           All gaps from Screen edges are the same → concentric radii work. -->
      <jiv class="ChromeFrame">
        <jiv class="ToolbarRow">
          <jiv class="ToolbarLogo" image="ss-logo" />
          <jiv class="ToolbarDropdown">
            <jiv class="ToolbarAvatar">
              <jext class="ToolbarAvatarGlyph" [text]="AvatarIcon" />
            </jiv>
          </jiv>
        </jiv>

        <jiv class="TabBarRow">
          <jiv class="TabBar">
            @for (t of Tabs(); track t.Label; let i = $index) {
              <jiv [class]="i === Selected() ? 'TabItemActive' : 'TabItem'"
                   (click)="Select(i)">
                <jext [class]="i === Selected() ? 'TabIconActive' : 'TabIcon'"
                      [text]="i === Selected() ? t.IconFill : t.Icon" />
                <jext [class]="i === Selected() ? 'TabLabelActive' : 'TabLabel'"
                      [text]="t.Label" />
              </jiv>
            }
          </jiv>
        </jiv>
      </jiv>

      <jiv class="Scroll">

        <!-- Hero stub — will become 3D reality view -->
        <jiv class="HeroStub">
          <jext class="HeroTitle" text="The greatest marching band software in the land" />
          <jiv class="HeroCta">
            <jext class="HeroCtaLabel" text="Get Started" />
          </jiv>
        </jiv>

        @for (s of Sections(); track s.Title) {
          <jiv class="Section">
            <jiv class="SectionHeader">
              <jext class="SectionTitle" [text]="s.Title" />
              <jiv class="SectionViewAll">
                <jext class="SectionViewAllLabel" text="View All" />
              </jiv>
            </jiv>
            <jiv [class]="s.RowClass">
              @for (c of s.Items; track c.Title) {
                <jiv [class]="s.CardClass" [style]="{ Background: c.Color }">
                  <jext class="CardKicker" [text]="c.Kicker" />
                  <jext [class]="s.TitleClass" [text]="c.Title" />
                </jiv>
              }
            </jiv>
          </jiv>
        }

      </jiv>

    </jiv>
  `,
})
export class Home {
  readonly JssSource = HomeJss;
  private _canvas = inject(JwiftCanvas);

  constructor() {
    afterNextRender(() => {
      this._canvas.Canvas.Images.LoadSvg('ss-logo', LOGO_SVG, 120, 46);
    });
  }

  readonly Featured = signal<CardRef[]>([
    { Kicker: 'FEATURED', Title: 'Reflections',     Color: 'rgb(60, 92, 190)' },
    { Kicker: 'FEATURED', Title: 'Deep Focus',      Color: 'rgb(160, 72, 200)' },
    { Kicker: 'FEATURED', Title: 'Northern Lights', Color: 'rgb(40, 120, 150)' },
  ]);

  readonly Trending = signal<CardRef[]>([
    { Kicker: 'TRENDING', Title: 'Sunset Run',      Color: 'rgb(220, 100, 60)' },
    { Kicker: 'TRENDING', Title: 'Evergreen',       Color: 'rgb(70, 140, 90)' },
    { Kicker: 'TRENDING', Title: 'Quiet Hours',     Color: 'rgb(90, 90, 120)' },
    { Kicker: 'TRENDING', Title: 'Coastline',       Color: 'rgb(30, 140, 160)' },
  ]);

  readonly Continue = signal<CardRef[]>([
    { Kicker: 'WORKOUT',  Title: 'Morning Routine', Color: 'rgb(210, 90, 120)' },
    { Kicker: 'PLAYLIST', Title: 'Late Night',      Color: 'rgb(80, 80, 160)' },
    { Kicker: 'SHOW',     Title: 'Inside the Loop', Color: 'rgb(180, 120, 60)' },
  ]);

  readonly Store = signal<CardRef[]>([
    { Kicker: 'NEW',      Title: 'Pulse',           Color: 'rgb(200, 60, 100)' },
    { Kicker: 'NEW',      Title: 'Slow Burn',       Color: 'rgb(140, 80, 60)' },
    { Kicker: 'NEW',      Title: 'Flowstate',       Color: 'rgb(60, 160, 130)' },
  ]);

  /** Double-click anywhere toggles an extra card in the Featured row — a
   *  visual probe for whether nodes entering/leaving the tree pick up any
   *  @enter/@exit animation. Right now it's a hard pop; once those hooks
   *  land it should spring/fade. Listens on document since Jiv's `<jiv>`
   *  tag sits beside the canvas in the DOM, not inside it — canvas
   *  dblclicks wouldn't otherwise reach Angular's template bindings. */
  readonly ExtraCard = signal(false);
  @HostListener('document:dblclick')
  ToggleExtra(): void { this.ExtraCard.update(v => !v); }

  /** Drives the carousel sections. Big = Featured/Trending; Compact =
   *  Continue/Store. The template loops this once instead of four near-
   *  identical hand-written blocks. */
  readonly Sections = computed<SectionData[]>(() => {
    const featured: CardRef[] = [...this.Featured()];
    if (this.ExtraCard()) {
      featured.push({ Kicker: 'BONUS', Title: 'Toggle me', Color: 'rgb(220, 60, 200)' });
    }
    return [
      { Title: 'Featured', Items: featured,
        RowClass: 'Row', CardClass: 'Card', TitleClass: 'CardTitle' },
      { Title: 'Trending', Items: this.Trending(),
        RowClass: 'Row', CardClass: 'Card', TitleClass: 'CardTitle' },
      { Title: 'Continue Where You Left Off', Items: this.Continue(),
        RowClass: 'RowCompact', CardClass: 'CardCompact', TitleClass: 'CardTitleCompact' },
      { Title: 'New in the Store', Items: this.Store(),
        RowClass: 'RowCompact', CardClass: 'CardCompact', TitleClass: 'CardTitleCompact' },
    ];
  });

  readonly Tabs = signal([
    { Label: 'Home',    Icon: String.fromCodePoint(0xF238), IconFill: String.fromCodePoint(0xF243) },
    { Label: 'Store',   Icon: String.fromCodePoint(0xE6D7), IconFill: String.fromCodePoint(0xE6DE) },
    { Label: 'Library', Icon: String.fromCodePoint(0xE7C0), IconFill: String.fromCodePoint(0xE7C1) },
    { Label: 'Band',    Icon: String.fromCodePoint(0xF64A), IconFill: String.fromCodePoint(0xF64A) },
    { Label: 'Search',  Icon: String.fromCodePoint(0xF558), IconFill: String.fromCodePoint(0xF558) },
  ]);

  readonly AvatarIcon = String.fromCodePoint(0xF791); // person.fill — matches Show Studio

  readonly Selected = signal(0);
  Select(i: number): void { this.Selected.set(i); }
}
