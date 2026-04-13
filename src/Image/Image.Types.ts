export type ObjectFit = 'Cover' | 'Contain' | 'Fill' | 'None';

export interface ImageStyle {
  Src: string;
  ObjectFit: ObjectFit;
  ObjectPositionX: number;     // 0-1 fraction
  ObjectPositionY: number;     // 0-1 fraction
}

export const DefaultImageStyle: ImageStyle = {
  Src: '',
  ObjectFit: 'Cover',
  ObjectPositionX: 0.5,
  ObjectPositionY: 0.5,
};
