import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { Jiv, Jext, Jyle } from 'jwift-angular';
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

@Component({
  selector: 'home',
  standalone: true,
  imports: [Jiv, Jext, Jyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <jyle [source]="JssSource" />

    <jiv class="Screen">

      <!-- Top toolbar row (inline for v1; floating-over-content comes
           with X/Y inputs on <jiv> — task TBD) -->
      <jiv class="ToolbarRow">
        <jiv class="Toolbar">
          <jiv class="ToolbarButton"><jext class="ToolbarButtonGlyph" text="▾" /></jiv>
          <jiv class="ToolbarButton"><jext class="ToolbarButtonGlyph" text="⚲" /></jiv>
          <jiv class="ToolbarButton"><jext class="ToolbarButtonGlyph" text="＋" /></jiv>
          <jiv class="ToolbarButton"><jext class="ToolbarButtonGlyph" text="☰" /></jiv>
        </jiv>
      </jiv>

      <!-- Progressive blur feather — sits over the lower part of the
           scroll area and under the TabBar. All geometry comes from the
           .ContentBlur JSS class (Position: Fixed + Bottom/Left/Width). -->
      <jiv class="ContentBlur" />

      <jiv class="Scroll">

        <!-- Hero stub (will become the 3D reality view) -->
        <jiv class="HeroStub">
          <jext class="HeroKicker" text="TODAY" />
          <jext class="HeroTitle" text="Your Show Studio" />
        </jiv>

        <!-- Featured (big cards) -->
        <jiv class="Section">
          <jiv class="SectionHeader">
            <jext class="SectionTitle" text="Featured" />
            <jiv class="SectionViewAll">
              <jext class="SectionViewAllLabel" text="View All" />
            </jiv>
          </jiv>
          <jiv class="Row">
            @for (c of Featured(); track c.Title) {
              <jiv class="Card" [style]="{ Background: c.Color }">
                <jext class="CardKicker" [text]="c.Kicker" />
                <jext class="CardTitle" [text]="c.Title" />
              </jiv>
            }
          </jiv>
        </jiv>

        <!-- Trending (big cards) -->
        <jiv class="Section">
          <jiv class="SectionHeader">
            <jext class="SectionTitle" text="Trending" />
            <jiv class="SectionViewAll">
              <jext class="SectionViewAllLabel" text="View All" />
            </jiv>
          </jiv>
          <jiv class="Row">
            @for (c of Trending(); track c.Title) {
              <jiv class="Card" [style]="{ Background: c.Color }">
                <jext class="CardKicker" [text]="c.Kicker" />
                <jext class="CardTitle" [text]="c.Title" />
              </jiv>
            }
          </jiv>
        </jiv>

        <!-- Continue Where You Left Off (compact) -->
        <jiv class="SectionCompact">
          <jiv class="SectionHeader">
            <jext class="SectionTitle" text="Continue Where You Left Off" />
            <jiv class="SectionViewAll">
              <jext class="SectionViewAllLabel" text="View All" />
            </jiv>
          </jiv>
          <jiv class="RowCompact">
            @for (c of Continue(); track c.Title) {
              <jiv class="CardCompact" [style]="{ Background: c.Color }">
                <jext class="CardKicker" [text]="c.Kicker" />
                <jext class="CardTitleCompact" [text]="c.Title" />
              </jiv>
            }
          </jiv>
        </jiv>

        <!-- New in the Store (compact) -->
        <jiv class="SectionCompact">
          <jiv class="SectionHeader">
            <jext class="SectionTitle" text="New in the Store" />
            <jiv class="SectionViewAll">
              <jext class="SectionViewAllLabel" text="View All" />
            </jiv>
          </jiv>
          <jiv class="RowCompact">
            @for (c of Store(); track c.Title) {
              <jiv class="CardCompact" [style]="{ Background: c.Color }">
                <jext class="CardKicker" [text]="c.Kicker" />
                <jext class="CardTitleCompact" [text]="c.Title" />
              </jiv>
            }
          </jiv>
        </jiv>

      </jiv>

      <!-- Bottom nav (glass, pill) — inline row for v1 -->
      <jiv class="TabBarRow">
        <jiv class="TabBar">
          @for (t of Tabs(); track t.Label; let i = $index) {
            <jiv [class]="i === Selected() ? 'TabItemActive' : 'TabItem'"
                 (click)="Select(i)">
              <jext [class]="i === Selected() ? 'TabLabelActive' : 'TabLabel'"
                    [text]="t.Label" />
            </jiv>
          }
        </jiv>
      </jiv>

    </jiv>
  `,
})
export class Home {
  readonly JssSource = HomeJss;

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

  readonly Tabs = signal([
    { Label: 'Home' },
    { Label: 'Discover' },
    { Label: 'Activity' },
    { Label: 'Profile' },
  ]);

  readonly Selected = signal(0);
  Select(i: number): void { this.Selected.set(i); }
}
