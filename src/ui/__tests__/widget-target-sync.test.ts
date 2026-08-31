/**
 * `ios/` is generated. Editing the source and building compiles the *copy*.
 *
 * `targets/RidikWidget/` is the source of truth — it is what is committed, and
 * `@bacons/apple-targets` copies it into `ios/RidikWidget/` during prebuild. The
 * Xcode project's file references point at `ios/RidikWidget/…`, so `xcodebuild`
 * never reads `targets/` at all.
 *
 * That is a silent trap and it cost a full round of "fixed it" / "no it isn't":
 * four faces were repaired in `targets/`, the widget scheme was built, it
 * reported **BUILD SUCCEEDED with zero errors**, and the tile on the home screen
 * did not change by one pixel — because the build had faithfully compiled the
 * months-old copies. A green build is not evidence that your edit was compiled.
 *
 * So this asserts the two directories agree, and it is the cheap guard that the
 * whole episode was missing. It **skips** when `ios/` is absent, which is the
 * normal state of a fresh clone and of CI: `ios/` is gitignored, and a test that
 * failed there would be noise rather than a signal.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = join(ROOT, 'targets', 'RidikWidget');
const GENERATED = join(ROOT, 'ios', 'RidikWidget');

const generatedExists = existsSync(GENERATED);
const describeIfPrebuilt = generatedExists ? describe : describe.skip;

describeIfPrebuilt('the generated iOS widget copy matches its source', () => {
  const swift = readdirSync(SOURCE).filter((f) => f.endsWith('.swift'));

  it('has files to compare', () => {
    expect(swift.length).toBeGreaterThan(10);
  });

  it.each(swift)('%s is identical in ios/RidikWidget', (name) => {
    const generated = join(GENERATED, name);
    expect(existsSync(generated)).toBe(true);
    // Compared as text, so a failure diffs readably instead of saying
    // "Buffer(41231) !== Buffer(41902)".
    expect(readFileSync(generated, 'utf8')).toBe(
      readFileSync(join(SOURCE, name), 'utf8'),
    );
  });
});
