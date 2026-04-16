export interface CpanelServer {
  id: string;
  label: string;
  host: string;
  cpanelUser: string;
  sshPort: number;
  cpanelPort: number;
  createdAt: string;
  lastConnectedAt?: string;
}
