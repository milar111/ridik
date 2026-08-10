/**
 * The two faces, loaded once at startup.
 *
 * Only the weights the type scale actually names are bundled. A family's full
 * range is seven files, and shipping four unused ones costs the user download
 * size for nothing.
 *
 * Registered under short keys rather than the packages' own long export names,
 * so `theme.fonts` reads as a design decision instead of an import path.
 */
import { useFonts } from 'expo-font';
import {
  BricolageGrotesque_400Regular,
  BricolageGrotesque_500Medium,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from '@expo-google-fonts/bricolage-grotesque';
import { MartianMono_300Light, MartianMono_500Medium } from '@expo-google-fonts/martian-mono';

export const APP_FONTS = {
  Bricolage_400Regular: BricolageGrotesque_400Regular,
  Bricolage_500Medium: BricolageGrotesque_500Medium,
  Bricolage_600SemiBold: BricolageGrotesque_600SemiBold,
  Bricolage_700Bold: BricolageGrotesque_700Bold,
  Bricolage_800ExtraBold: BricolageGrotesque_800ExtraBold,
  Martian_300Light: MartianMono_300Light,
  Martian_500Medium: MartianMono_500Medium,
};

/**
 * True once the faces are usable.
 *
 * The caller holds the splash screen on `false` rather than rendering with a
 * fallback: this type scale sets tracking and line height for these specific
 * faces, and the system font in those metrics reflows every label the moment
 * the real one lands.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(APP_FONTS);
  // A font that will not load must not hold the app hostage — better the
  // system face than a splash screen forever.
  return loaded || error !== null;
}
