export interface CpanelServer {
  id: string;
  label: string;
  host: string;
  cpanelUser: string;
  sshPort: number;
  cpanelPort: number;
  createdAt: string;
  lastConnectedAt?: string;
  /** When true (or undefined), SSL certificates are verified on cPanel API calls. Set to false only when the server uses a self-signed or locally-trusted cert that the user has explicitly acknowledged. */
  rejectUnauthorizedSsl?: boolean;
  /**
   * SHA256 fingerprint (hex) of the SSH host key seen on this server's first
   * successful connection. Pinned on trust-on-first-use; every later connection
   * must present the same key, or SshClient refuses the connection — this is
   * what SSH host-key verification protects against (a changed key can mean
   * a legitimate server migration, or an on-path attacker).
   */
  hostKeyFingerprint?: string;
}
