/** Stored in vscode.SecretStorage — never in globalState or on disk */
export interface StoredCredentials {
  type: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface ResolvedCredentials extends StoredCredentials {
  serverId: string;
}
