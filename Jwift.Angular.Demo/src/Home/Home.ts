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

      <!-- Progressive blur feathers -->
      <jiv class="TopBlur" />
      <jiv class="ContentBlur" />

      <jiv class="Scroll">

        <!-- Hero stub — will become 3D reality view -->
        <jiv class="HeroStub">
          <jext class="HeroTitle" text="The greatest marching band software in the land" />
          <jiv class="HeroCta">
            <jext class="HeroCtaLabel" text="Get Started" />
          </jiv>
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
              <jext [class]="i === Selected() ? 'TabIconActive' : 'TabIcon'"
                    [text]="i === Selected() ? t.IconFill : t.Icon" />
              <jext [class]="i === Selected() ? 'TabLabelActive' : 'TabLabel'"
                    [text]="t.Label" />
            </jiv>
          }
        </jiv>
      </jiv>

      <!-- Toolbar LAST in tree = renders on top of all glass (z-order) -->
      <jiv class="ToolbarRow">
        <jext class="ToolbarTitle" text="Show Studio" />
        <jiv class="ToolbarDropdown">
          <jiv class="ToolbarAvatar">
            <jext class="ToolbarAvatarGlyph" text="👤" />
          </jiv>
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
    { Label: 'Home',    Icon: String.fromCodePoint(0xF238), IconFill: String.fromCodePoint(0xF243) },
    { Label: 'Store',   Icon: String.fromCodePoint(0xE6D7), IconFill: String.fromCodePoint(0xE6DE) },
    { Label: 'Library', Icon: String.fromCodePoint(0xE7C0), IconFill: String.fromCodePoint(0xE7C1) },
    { Label: 'Band',    Icon: String.fromCodePoint(0xF64A), IconFill: String.fromCodePoint(0xF64A) },
    { Label: 'Search',  Icon: String.fromCodePoint(0xF558), IconFill: String.fromCodePoint(0xF558) },
  ]);

  readonly Selected = signal(0);
  Select(i: number): void { this.Selected.set(i); }
}
