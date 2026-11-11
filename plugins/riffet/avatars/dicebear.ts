// The CC0 styles of DiceBear (MIT, https://github.com/dicebear/dicebear), drawn with the owner's theme colors.
// Only the definitions listed here are imported, so the rest of `@dicebear/styles` stays out of the bundle.

import { Avatar, Style, type StyleDefinition } from '@dicebear/core';
import cutouts from '@dicebear/styles/cutouts.json' with { type: 'json' };
import critters from '@dicebear/styles/critters.json' with { type: 'json' };
import landscape from '@dicebear/styles/landscape.json' with { type: 'json' };
import lineFace from '@dicebear/styles/line-face.json' with { type: 'json' };
import lorelei from '@dicebear/styles/lorelei.json' with { type: 'json' };
import notionists from '@dicebear/styles/notionists.json' with { type: 'json' };
import openPeeps from '@dicebear/styles/open-peeps.json' with { type: 'json' };
import patchwork from '@dicebear/styles/patchwork.json' with { type: 'json' };
import planets from '@dicebear/styles/planets.json' with { type: 'json' };
import shadows from '@dicebear/styles/shadows.json' with { type: 'json' };
import sprouts from '@dicebear/styles/sprouts.json' with { type: 'json' };
import type { AvatarStyleProvider } from '@riffet/plugin-api';

interface Definition { meta: { license: { text: string } }; colors: Record<string, { values: string[] }> }

export interface DiceBearStyle {
  /** The id's name part, `riffet.avatars/<name>`. */
  name: string;
  title: string;
  /** Line art: its black lines and glyphs take the theme's ink and its white fills the paper; the other styles keep their own colors. */
  lineArt?: boolean;
  definition: Definition;
}

export const DICEBEAR_STYLES: readonly DiceBearStyle[] = [
  { name: 'notionists', title: 'Notionists', lineArt: true, definition: notionists },
  { name: 'lorelei', title: 'Lorelei', lineArt: true, definition: lorelei },
  { name: 'open-peeps', title: 'Open Peeps', lineArt: true, definition: openPeeps },
  { name: 'line-face', title: 'Line Face', lineArt: true, definition: lineFace },
  { name: 'shadows', title: 'Shadows', definition: shadows },
  { name: 'cutouts', title: 'Cutouts', definition: cutouts },
  { name: 'sprouts', title: 'Sprouts', definition: sprouts },
  { name: 'critters', title: 'Critters', definition: critters },
  { name: 'planets', title: 'Planets', definition: planets },
  { name: 'landscape', title: 'Landscape', definition: landscape },
  { name: 'patchwork', title: 'Patchwork', definition: patchwork },
] as unknown as readonly DiceBearStyle[];

/** The attribution the style's definition asks for. */
export const creditOf = (style: DiceBearStyle): string => style.definition.meta.license.text;

const hex = (color: string): string => color.replace(/^#/, '').toLowerCase();
const only = (values: string[], color: string): boolean => values.length === 1 && values[0]!.toLowerCase() === color;

export function diceBearProvider(style: DiceBearStyle): AvatarStyleProvider {
  const colors = Object.entries(style.definition.colors);
  const inkGroups = style.lineArt ? colors.filter(([group, { values }]) => group === 'ink' || only(values, '#000000')).map(([group]) => group) : [];
  const paperGroups = style.lineArt ? colors.filter(([, { values }]) => only(values, '#ffffff')).map(([group]) => group) : [];
  // Built on first use: eleven definitions are not worth parsing before anyone asks for an avatar.
  let built: Style | undefined;
  return {
    generate({ seed, size, ink, paper }) {
      built ??= new Style(style.definition as unknown as StyleDefinition);
      const options: Record<string, unknown> = { seed, size, backgroundColor: [hex(paper)] };
      for (const group of inkGroups) options[`${group}Color`] = [hex(ink)];
      for (const group of paperGroups) options[`${group}Color`] = [hex(paper)];
      return new Avatar(built, options).toString();
    },
  };
}
