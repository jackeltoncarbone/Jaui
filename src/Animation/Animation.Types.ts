export interface SpringConfig {
  Stiffness: number;
  Damping: number;
  Mass: number;
}

export interface TransitionConfig {
  Duration: number;            // ms
  Easing: 'Linear' | 'EaseOut' | 'EaseInOut' | 'Spring';
  Spring: SpringConfig | null; // used when Easing = 'Spring'
}

export const DefaultSpringConfig: SpringConfig = {
  Stiffness: 170,
  Damping: 26,
  Mass: 1,
};

// Default transition: dissolve linearly (opacity animation)
export const DefaultTransition: TransitionConfig = {
  Duration: 200,
  Easing: 'Linear',
  Spring: null,
};
