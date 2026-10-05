import { compareVersions, downloadUrlProblem, VERSION_PATTERN } from './app-release.rules';

describe('app release rules', () => {
  it('versions are three numbers', () => {
    expect(VERSION_PATTERN.test('1.2.0')).toBe(true);
    expect(VERSION_PATTERN.test('10.0.12')).toBe(true);
    expect(VERSION_PATTERN.test('1.2')).toBe(false);
    expect(VERSION_PATTERN.test('1.2.0-beta')).toBe(false);
    expect(VERSION_PATTERN.test('v1.2.0')).toBe(false);
  });

  it('compares versions part by part, as numbers', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  it('phones download only over https - or from this machine while developing', () => {
    expect(downloadUrlProblem('https://example.com/mela.apk')).toBeNull();
    expect(
      downloadUrlProblem('https://play.google.com/store/apps/details?id=com.melalive.app'),
    ).toBeNull();
    expect(downloadUrlProblem('http://localhost:9090/mela.apk')).toBeNull();
    expect(downloadUrlProblem('http://example.com/mela.apk')).toMatch(/https/);
    expect(downloadUrlProblem('ftp://example.com/mela.apk')).toMatch(/https/);
    expect(downloadUrlProblem('mela.apk')).toMatch(/full link/);
  });
});
