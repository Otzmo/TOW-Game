import type { PlayerId } from '../model/types';

/** Pixel pro Zoll in Weltkoordinaten. */
export const PPI = 20;

export const PLAYER_COLORS: Record<PlayerId, { fill: number; edge: number; dark: number; css: string }> = {
  p1: { fill: 0x7a1414, edge: 0xe0b44c, dark: 0x2a0606, css: '#7a1414' },
  p2: { fill: 0x1c3f7a, edge: 0xcfd8e6, dark: 0x08142a, css: '#1c3f7a' },
};

export const TABLE_COLOR = 0x3f5a33;
export const GUIDE_COLOR = 0xe0b44c;
