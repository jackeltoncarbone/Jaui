export interface AccessibilityConfig {
  Role: string | null;         // button, textbox, slider, etc.
  AriaLabel: string | null;
  TabIndex: number | null;
}

export const DefaultAccessibility: AccessibilityConfig = {
  Role: null,
  AriaLabel: null,
  TabIndex: null,
};
