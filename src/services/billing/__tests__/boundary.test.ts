/**
 * The store SDK stops at this folder.
 *
 * `entitlement.ts` defines a `BillingProvider` port in the app's own words —
 * `Plan`, `Entitlement`, `PlanId`, `PlanTier`. Nothing in that interface is a
 * RevenueCat type, which is what makes RevenueCat replaceable: swapping to
 * StoreKit and Play Billing means writing one more file next to
 * `revenuecat.ts` and changing which one `index.ts` registers. Two providers
 * already sit behind the port, so this is a demonstrated property rather than
 * an intended one.
 *
 * That property is true today and nothing was stopping it from quietly
 * stopping being true. It only takes one paywall reaching for `Purchases`
 * directly — to read a field the port does not expose, under deadline — and
 * the migration silently becomes a refactor of every screen that touches
 * money. The failure mode is invisible: the app keeps working, and the cost
 * only appears months later, on the day someone tries to remove the SDK.
 *
 * So the boundary is asserted here by reading the source. A crude test, and
 * the only kind available for "nobody imported this".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Where the SDK is allowed to be named at all. */
const BILLING = join('src', 'services', 'billing');

/**
 * What may not be imported outside `src/services/billing/`.
 *
 * The SDK itself, and the concrete provider that wraps it. The provider is on
 * the list because importing `createRevenueCatProvider` directly bypasses the
 * port just as completely as importing `Purchases` does — it is the same
 * mistake with an extra step, and it is the more tempting of the two because
 * it looks like an internal import rather than a vendor one.
 */
const FORBIDDEN = [
  'react-native-purchases',
  'billing/revenuecat',
  './revenuecat',
];

/** Every source file in the app, excluding the billing folder itself. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const skip = new Set(['node_modules', 'android', 'ios', 'dist', '.git', '__tests__']);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (rel.startsWith(BILLING)) continue;
      found.push(rel);
    }
  };

  walk('src');
  walk('app');
  return found;
}

describe('the store SDK does not leak past the billing service', () => {
  const files = sourceFiles();

  it('finds the app to check (a walk that finds nothing would pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)('nothing outside src/services/billing imports %s', (specifier) => {
    const offenders = files.filter((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      // Imports and requires only. A comment naming the SDK is documentation,
      // and two of them are load-bearing explanations of this very boundary.
      const pattern = new RegExp(
        `(?:from|require\\()\\s*['"][^'"]*${specifier.replace(/[./]/g, '\\$&')}['"]`,
      );
      return pattern.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the port is written in the app\'s own words', () => {
  const entitlement = readFileSync(join(ROOT, BILLING, 'entitlement.ts'), 'utf8');

  /**
   * The names RevenueCat would push through the interface if it were allowed
   * to. Each one is a type the app would then have to keep answering for after
   * the SDK was gone — `CustomerInfo` in particular has no equivalent in
   * StoreKit and would have to be faked forever.
   */
  it.each(['CustomerInfo', 'PurchasesOffering', 'PurchasesPackage', 'PurchasesStoreProduct'])(
    'no %s in the provider contract',
    (vendorType) => {
      expect(entitlement).not.toContain(vendorType);
    },
  );
});
