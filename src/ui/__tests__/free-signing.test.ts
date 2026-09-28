/**
 * The free-signing switch, and the fact that it is off.
 *
 * `RIDIK_FREE_SIGNING=1` produces an iOS project a **free Apple ID** can sign,
 * so the app can go on somebody's phone for seven days without the $99
 * Developer Program. It does that by taking things away — the App Group, the
 * WidgetKit target, and every entitlement the Developer portal provisions —
 * and every one of those is something a store build needs.
 *
 * So the thing worth testing is not that the switch works. It is that it is
 * **off unless asked for**, and that turning it on removes exactly what it
 * claims to. A build that shipped in this state would reach the App Store with
 * no widgets and no time-sensitive reminders, and nothing would have said so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = readFileSync(join(__dirname, '..', '..', '..', 'app.config.ts'), 'utf8');
const PLUGIN = readFileSync(
  join(__dirname, '..', '..', '..', 'plugins', 'withRidikFreeSigning.js'),
  'utf8',
);

describe('the free-signing build', () => {
  /** One env var, read once, compared to an exact string. */
  it('is off unless the environment asks for it by name', () => {
    expect(CONFIG).toContain("const FREE_SIGNING = process.env.RIDIK_FREE_SIGNING === '1'");
    // Never truthiness: `RIDIK_FREE_SIGNING=0` must mean off, and it would not
    // if this were a bare `Boolean(process.env...)`.
    expect(CONFIG).not.toMatch(/FREE_SIGNING = Boolean\(/);
  });

  /*
   * The widget target and the App Group have to leave together. The plugin is
   * the only source of the group, and a widget with no shared container is a
   * blank tile rather than a missing one — worse, because it looks broken.
   */
  it('drops the widget plugin, which is what drops the App Group', () => {
    expect(CONFIG).toContain("...(FREE_SIGNING ? [] : ['./plugins/withRidikIosWidget'])");
  });

  it('keeps time-sensitive notifications out of a free-signed build only', () => {
    expect(CONFIG).toContain(
      "...(FREE_SIGNING ? {} : { 'com.apple.developer.usernotifications.time-sensitive': true })",
    );
  });

  /*
   * `expo-notifications` writes `aps-environment` unconditionally and offers no
   * prop to stop it, so omitting plugins cannot remove it — the finished plist
   * has to be edited. Push Notifications is portal-provisioned, so leaving it
   * in fails provisioning with a message about a missing profile that names no
   * entitlement at all.
   */
  it('strips the entitlements no personal team can be granted', () => {
    for (const key of [
      'aps-environment',
      'com.apple.developer.usernotifications.time-sensitive',
      'com.apple.security.application-groups',
    ]) {
      expect(PLUGIN).toContain(key);
    }
  });

  /*
   * The ordering that cost an hour. Expo's mods compose in reverse: the plugin
   * listed *last* runs *first*. Registered at the end of the array the stripper
   * was handed an empty entitlements dict, deleted nothing, and left a plist
   * that looked exactly as it had — no warning anywhere.
   */
  it('registers the stripper first, which is what makes it run last', () => {
    const stripper = CONFIG.indexOf("'./plugins/withRidikFreeSigning'");
    const notifications = CONFIG.indexOf("'expo-notifications'");
    expect(stripper).toBeGreaterThan(-1);
    expect(stripper).toBeLessThan(notifications);
  });
});
