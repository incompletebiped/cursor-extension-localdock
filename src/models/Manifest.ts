export interface ManifestFileEntry {
  size: number;
  mtime: number;
  md5: string;
}

export interface SiteManifest {
  version: 1;
  domain: string;
  serverHost: string;
  serverId: string;
  pulledAt: string;
  wpVersion: string;
  dbName: string;
  dbLocalName: string;
  fileIndex: Record<string, ManifestFileEntry>;
}
