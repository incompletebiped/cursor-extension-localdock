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
}
