export interface NetworkProfile {
  uuid: string;
  name: string;
  ssid: string;
  priority: number;
  autoconnect: boolean;
  authRetries: number;
  security: string;
  backend: "keyfile" | "netplan";
}

export type NetworkPurpose = "home" | "hotspot";
export type NetworkPhase =
  | "saved"
  | "trying"
  | "waiting"
  | "restoring"
  | "failed"
  | "restored"
  | "confirming"
  | "promoting"
  | "identity"
  | "retiring"
  | "kept";

export interface NetworkChange {
  uuid: string;
  ssid: string;
  purpose: NetworkPurpose;
  replaced: NetworkProfile | null;
  fallback: NetworkProfile | null;
  phase: NetworkPhase;
  checkpoint: string | null;
  priority: number;
  attempts: number;
  message: string;
  resumedAtBoot: boolean;
}

export interface NetworkLedger {
  version: 1;
  instanceId: string;
  revision: number;
  purposes: Record<string, NetworkPurpose>;
  excluded: string[];
  change: NetworkChange | null;
}

export interface NetworkAddress {
  uuid: string;
  address: string;
}

export interface NetworkBackend {
  list: () => Promise<NetworkProfile[]>;
  active: () => Promise<NetworkAddress | null>;
  add: (profile: NetworkProfile, password: string, hidden: boolean) => Promise<void>;
  secret: (uuid: string) => Promise<string>;
  verify: (uuid: string, absent?: boolean, backend?: NetworkProfile["backend"]) => Promise<void>;
  policy: (uuid: string, priority: number) => Promise<void>;
  remove: (uuid: string) => Promise<void>;
  activate: (uuid: string) => Promise<void>;
  deactivate: (uuid: string) => Promise<void>;
  checkpoint: (seconds: number) => Promise<string>;
  checkpoints: () => Promise<string[]>;
  destroy: (path: string) => Promise<void>;
  rollback: (path: string) => Promise<void>;
  scan: () => Promise<string[]>;
  close: () => void;
}

export interface NetworkView {
  ok: boolean;
  message: string;
  instanceId: string;
  generation: string;
  revision: number;
  settingsRevision: number | null;
  profiles: (NetworkProfile & { purpose: NetworkPurpose | null })[];
  active: NetworkAddress | null;
  change: NetworkChange | null;
  remainingMs: number | null;
  canKeep: boolean;
  viaBluetooth: boolean;
}

export interface NetworkRequestIdentity {
  instanceId: string;
  generation: string;
  revision: number;
  settingsRevision: number | null;
}

export interface NetworkDraft {
  ssid: string;
  purpose: NetworkPurpose;
  replacedUuid: string | null;
  passwordMode: "keep" | "change";
  password: string;
  hidden: boolean;
  accessPointChange: boolean;
  bluetoothTested: boolean;
}

export interface NetworkProof {
  localAddress: string;
  remoteAddress: string;
  tunnel: boolean;
}

export class NetworkRefusal extends Error {}
