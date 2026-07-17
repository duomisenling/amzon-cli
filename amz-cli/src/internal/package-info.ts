import { readFileSync } from 'node:fs';

export interface PackageInfo {
  name: string;
  version: string;
}

/** 从随包发布的 package.json 读取名称和版本，避免 CLI 帮助与 npm 版本漂移。 */
export function readPackageInfo(
  packageUrl: URL = new URL('../../package.json', import.meta.url),
): PackageInfo {
  const parsed = JSON.parse(readFileSync(packageUrl, 'utf8')) as Partial<PackageInfo>;
  if (!parsed.name || !parsed.version) {
    throw new Error(`invalid package metadata: ${packageUrl.href}`);
  }
  return { name: parsed.name, version: parsed.version };
}
