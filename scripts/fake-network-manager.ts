import type { NetworkBackend, NetworkProfile, NetworkAddress } from "../src/wifi/network-types.ts";

export class FakeNetworkManager implements NetworkBackend {
  time = 0;
  profiles = new Map<string, NetworkProfile>();
  disk = new Map<string, NetworkProfile>();
  passwords = new Map<string, string>();
  accessPoints = new Map<string, { password: string; readyAt: number }>();
  current: NetworkAddress | null = null;
  pending: { uuid: string; retries: number; nextAt: number } | null = null;
  checkpointsByPath = new Map<
    string,
    { expires: number; active: NetworkAddress | null; profiles: Map<string, NetworkProfile> }
  >();
  events: string[] = [];
  authAttempts: string[] = [];
  lastUsed = new Map<string, number>();
  loseWrite = false;
  failAt: string | null = null;

  list = async (): Promise<NetworkProfile[]> => structuredClone([...this.profiles.values()]);
  active = async (): Promise<NetworkAddress | null> => {
    this.advanceNetworkManager();
    return structuredClone(this.current);
  };
  add = async (profile: NetworkProfile, password: string, _hidden: boolean): Promise<void> => {
    this.events.push("add");
    this.profiles.set(profile.uuid, structuredClone(profile));
    this.passwords.set(profile.uuid, password);
    if (!this.loseWrite) {
      this.disk.set(profile.uuid, structuredClone(profile));
    }
    this.loseWrite = false;
  };
  secret = async (uuid: string): Promise<string> => this.passwords.get(uuid) ?? "";
  verify = async (uuid: string, absent = false): Promise<void> => {
    if (this.profiles.has(uuid) === absent || this.disk.has(uuid) === absent) {
      throw new Error("Persistent profile mismatch");
    }
  };
  policy = async (uuid: string, priority: number, confirmed = true): Promise<void> => {
    this.trip("policy");
    this.events.push("policy");
    const profile = this.profiles.get(uuid)!;
    Object.assign(profile, { autoconnect: confirmed, authRetries: confirmed ? 0 : 1, priority });
    this.disk.set(uuid, structuredClone(profile));
  };
  remove = async (uuid: string): Promise<void> => {
    this.trip("remove");
    this.events.push(`remove:${uuid}`);
    this.profiles.delete(uuid);
    this.disk.delete(uuid);
    this.passwords.delete(uuid);
  };
  discard = async (uuid: string): Promise<void> => this.remove(uuid);
  activate = async (uuid: string): Promise<void> => {
    this.events.push(`activate:${uuid}`);
    const profile = this.profiles.get(uuid);
    if (!profile) return;
    this.current = null;
    this.pending = { uuid, retries: profile.authRetries, nextAt: this.time };
    this.advanceNetworkManager();
  };
  deactivate = async (uuid: string): Promise<void> => {
    this.events.push(`deactivate:${uuid}`);
    if (this.pending?.uuid === uuid) {
      this.pending = null;
    }
    if (this.current?.uuid === uuid) {
      this.current = null;
    }
  };
  checkpoint = async (seconds: number): Promise<string> => {
    const path = `/org/freedesktop/NetworkManager/Checkpoint/${this.checkpointsByPath.size + 1}`;
    this.checkpointsByPath.set(path, {
      expires: this.time + seconds * 1_000,
      active: structuredClone(this.current),
      profiles: structuredClone(this.profiles),
    });
    this.events.push(`checkpoint:${seconds}`);
    return path;
  };
  checkpoints = async (): Promise<string[]> => [...this.checkpointsByPath.keys()];
  destroy = async (path: string): Promise<void> => {
    this.trip("destroy");
    this.events.push("destroy");
    this.checkpointsByPath.delete(path);
  };
  rollback = async (path: string): Promise<void> => {
    const checkpoint = this.checkpointsByPath.get(path);
    if (!checkpoint) {
      throw new Error("Checkpoint absent");
    }
    this.events.push("rollback");
    this.current = structuredClone(checkpoint.active);
    this.profiles = structuredClone(checkpoint.profiles);
    this.pending = null;
    this.checkpointsByPath.delete(path);
  };
  scan = async (): Promise<string[]> =>
    [...this.accessPoints].filter(([, access]) => access.readyAt <= this.time).map(([name]) => name);
  close = (): void => {};

  boot(): void {
    this.events.push("boot");
    this.current = null;
    this.pending = null;
    this.profiles = structuredClone(this.disk);
    const eligible = [...this.profiles.values()]
      .filter(profile => profile.autoconnect)
      .sort(
        (left, right) =>
          right.priority - left.priority || (this.lastUsed.get(right.uuid) ?? 0) - (this.lastUsed.get(left.uuid) ?? 0)
      );
    for (const profile of eligible) {
      if (this.credentialsWork(profile.uuid)) {
        this.current = { uuid: profile.uuid, address: "192.0.2.20" };
        this.lastUsed.set(profile.uuid, this.time);
        return;
      }
    }
  }
  advanceNetworkManager(): void {
    for (const [path, checkpoint] of this.checkpointsByPath) {
      if (this.time >= checkpoint.expires) {
        this.current = structuredClone(checkpoint.active);
        this.profiles = structuredClone(checkpoint.profiles);
        this.pending = null;
        this.checkpointsByPath.delete(path);
        this.events.push("checkpoint-timeout");
      }
    }
    if (!this.pending || this.pending.nextAt > this.time) return;
    const pending = this.pending;
    this.authAttempts.push(pending.uuid);
    if (this.credentialsWork(pending.uuid)) {
      this.current = { uuid: pending.uuid, address: "192.0.2.30" };
      this.lastUsed.set(pending.uuid, this.time);
      this.pending = null;
    } else if (pending.retries === 0) {
      pending.nextAt = this.time + 1_000;
    } else {
      pending.retries -= 1;
      if (pending.retries <= 0) {
        this.pending = null;
      } else {
        pending.nextAt = this.time + 1_000;
      }
    }
  }
  credentialsWork(uuid: string): boolean {
    const profile = this.profiles.get(uuid);
    const access = profile ? this.accessPoints.get(profile.ssid) : null;
    return !!access && access.readyAt <= this.time && access.password === this.passwords.get(uuid);
  }
  trip(step: string): void {
    if (this.failAt === step) {
      this.failAt = null;
      throw new Error("Simulated power cut");
    }
  }
}
