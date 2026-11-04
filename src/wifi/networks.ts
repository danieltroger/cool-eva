import { networkView } from "./network-view.ts";
import { monotonicNow } from "../monotonic.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { HotspotNameOwnership } from "../settings/view.ts";
import { registeredHotspot } from "./network-hotspot.ts";
import { incompleteRecoveryMessage } from "../../public/lib/network-recovery.js";
import { acquireWifiOperation, excludeNetworkCandidates } from "./operation.ts";
import type { NetworkLedgerStore } from "./network-ledger.ts";
import { saveNetworkDraft } from "./network-save.ts";
import { finaliseNetwork, restoreNetwork } from "./network-transitions.ts";
import { reconcileNetworkStart, observeNetworkRestoration, pendingNetworkChange } from "./network-reconciliation.ts";
import {
  NetworkRefusal,
  type NetworkBackend,
  type NetworkDraft,
  type NetworkLedger,
  type NetworkProof,
  type NetworkRequestIdentity,
  type NetworkView,
  type NetworkProfile,
} from "./network-types.ts";

export class WifiNetworks {
  readonly generation: string;
  readonly options: NetworkOptions;
  deadline: number | null = null;
  attemptAt: number | null = null;
  nextAttempt = 0;
  restorationDeadline: number | null = null;
  fault = "";
  releaseWifi: (() => void) | null = null;
  reservation: Awaited<ReturnType<SettingsStore["reserve"]>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private knownProfiles: NetworkProfile[] | null = null;

  constructor(options: NetworkOptions) {
    this.options = options;
    this.generation = options.generation;
    excludeNetworkCandidates(options.ledger.read().excluded);
  }

  async start(): Promise<void> {
    await this.serial(() => reconcileNetworkStart(this)).catch(() => {
      this.fault = pendingNetworkChange(this)
        ? incompleteRecoveryMessage(this.state().change)
        : "Saved network details need repair. Read again or use the installation guide.";
      console.warn("wifi-settings: interrupted network change could not be reconciled; no values logged");
    });
    if (this.options.autoTick !== false) {
      this.timer = setInterval(() => {
        void this.tick().catch(error => {
          if (!(error instanceof NetworkRefusal)) {
            this.fault = pendingNetworkChange(this)
              ? incompleteRecoveryMessage(this.state().change)
              : "The Wi-Fi result could not be observed. Reconnect to read its result.";
          }
          console.warn("wifi-settings: trial observation failed; checkpoint remains the crash backstop");
        });
      }, 1_000);
    }
  }

  state(): NetworkLedger {
    return this.options.ledger.read();
  }
  now(): number {
    return (this.options.now ?? monotonicNow)();
  }
  settingsRevision(): number | null {
    const settings = this.options.settings.read();
    return settings.kind === "ready" ? settings.document.revision : null;
  }
  async listProfiles(): Promise<NetworkProfile[]> {
    const profiles = await this.options.backend.list();
    this.knownProfiles = profiles;
    return profiles;
  }
  hotspotNameOwnership(): HotspotNameOwnership {
    if (this.knownProfiles === null) return "unknown";
    return registeredHotspot(this.state(), this.knownProfiles) ? "network" : "manual";
  }
  async persist(changes: Partial<NetworkLedger>): Promise<void> {
    await this.options.ledger.write({ ...this.state(), ...changes });
    excludeNetworkCandidates(this.state().excluded);
  }

  view(proof: NetworkProof): Promise<NetworkView> {
    return this.serial(() => networkView(this, proof));
  }

  save(identity: NetworkRequestIdentity, draft: NetworkDraft, fromBluetooth: boolean): Promise<void> {
    return this.serial(async () => {
      this.check(identity);
      await saveNetworkDraft(this, draft, fromBluetooth, identity.settingsRevision);
    });
  }

  trial(identity: NetworkRequestIdentity): Promise<void> {
    return this.serial(async () => {
      this.check(identity);
      const change = this.state().change;
      if (!change || !["saved", "failed", "restored"].includes(change.phase)) {
        throw new NetworkRefusal("Read the saved candidate before trying it.");
      }
      this.motion();
      await this.take(identity.settingsRevision);
      try {
        await this.options.backend.verify(change.uuid);
        this.motion();
        await this.persist({
          change: {
            ...change,
            phase: "trying",
            attempts: 0,
            checkpoint: null,
            message: `Trying ${change.ssid}; the previous connection remains saved.`,
            resumedAtBoot: false,
          },
        });
        this.restorationDeadline = null;
        const trialStarted = this.now();
        const checkpoint = await this.options.backend.checkpoint(CHECKPOINT_SECONDS);
        this.deadline = trialStarted + TRIAL_MS;
        await this.persist({ change: { ...this.state().change!, checkpoint } });
        this.nextAttempt = this.now();
        this.attemptAt = null;
      } catch (error) {
        try {
          await restoreNetwork(this, "The trial could not start. The previous network remains saved.");
        } finally {
          await this.release();
        }
        throw error;
      }
    });
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      await observeNetworkRestoration(this);
      const change = this.state().change;
      if (this.deadline === null || !change || !["trying", "waiting"].includes(change.phase)) return;
      if (this.now() >= this.deadline) {
        try {
          await restoreNetwork(this, "Could not confirm the new network.");
        } finally {
          await this.release();
        }
        return;
      }
      const active = await this.options.backend.active();
      if (active?.uuid === change.uuid) {
        if (change.phase !== "waiting") {
          await this.persist({
            change: {
              ...change,
              phase: "waiting",
              message: `Pi connected to ${change.ssid}; waiting for this phone at http://${active.address}.`,
            },
          });
        }
        return;
      }
      if (this.attemptAt !== null && this.now() - this.attemptAt < ATTEMPT_MS) return;
      if (this.attemptAt !== null) {
        await this.options.backend.deactivate(change.uuid);
        this.attemptAt = null;
      }
      if (this.now() < this.nextAttempt) return;
      await this.persist({ change: { ...this.state().change!, phase: "trying", attempts: change.attempts + 1 } });
      if (this.deadline === null || this.now() >= this.deadline) {
        try {
          await restoreNetwork(this, "Could not confirm the new network.");
        } finally {
          await this.release();
        }
        return;
      }
      try {
        this.motion();
      } catch (error) {
        await restoreNetwork(this, "The motorcycle is no longer proven parked. The trial stopped.");
        await this.release();
        throw error;
      }
      this.attemptAt = this.now();
      this.nextAttempt = this.now() + RETRY_GAP_MS;
      await this.options.backend.activate(change.uuid);
    });
  }

  keep(identity: NetworkRequestIdentity, proof: NetworkProof): Promise<void> {
    return this.serial(async () => {
      this.check(identity);
      const view = await networkView(this, proof);
      if (!view.canKeep) {
        throw new NetworkRefusal("Open this Pi's address on the new Wi-Fi before keeping the network.");
      }
      try {
        await this.persist({
          change: { ...this.state().change!, phase: "confirming", message: "Confirming the new Wi-Fi connection." },
        });
        this.deadline = null;
        await finaliseNetwork(this);
      } finally {
        await this.release();
      }
    });
  }

  previous(identity: NetworkRequestIdentity): Promise<void> {
    return this.serial(async () => {
      this.check(identity, true);
      if (!this.releaseWifi) {
        if (!pendingNetworkChange(this)) {
          throw new NetworkRefusal("There is no live trial to cancel. Read back its result.");
        }
        await this.take(identity.settingsRevision);
      }
      try {
        await restoreNetwork(this, "The network trial was cancelled.");
        this.fault = "";
      } finally {
        await this.release();
      }
    });
  }

  cancel(identity: NetworkRequestIdentity): Promise<void> {
    return this.serial(async () => {
      this.check(identity);
      const change = this.state().change;
      if (!change || !["saved", "failed", "restored"].includes(change.phase)) {
        throw new NetworkRefusal("Use previous during a live trial, or read its result.");
      }
      await this.take(identity.settingsRevision);
      try {
        await this.options.backend.remove(change.uuid);
        await this.persist({ revision: this.state().revision + 1, change: null });
        this.restorationDeadline = null;
      } finally {
        await this.release();
      }
    });
  }

  maintenance(identity: NetworkRequestIdentity): Promise<void> {
    return this.serial(async () => {
      this.check(identity, true);
      if (!this.releaseWifi && pendingNetworkChange(this)) {
        await this.take(identity.settingsRevision);
      }
      if (this.releaseWifi) {
        try {
          await restoreNetwork(
            this,
            "Installation maintenance interrupted the trial. Try again explicitly when ready."
          );
          this.fault = "";
        } finally {
          await this.release();
        }
      }
    });
  }

  async scan(identity: NetworkRequestIdentity): Promise<string[]> {
    this.check(identity);
    const release = acquireWifiOperation("settings");
    if (!release) {
      throw new NetworkRefusal(RECOVERY_BUSY);
    }
    try {
      return await this.options.backend.scan();
    } finally {
      release();
    }
  }

  async take(revision: number | null): Promise<void> {
    if (this.releaseWifi) {
      throw new NetworkRefusal("A Wi-Fi change is already running.");
    }
    const release = acquireWifiOperation("settings");
    if (!release) {
      throw new NetworkRefusal(RECOVERY_BUSY);
    }
    this.releaseWifi = release;
    try {
      this.reservation = await this.options.settings.reserve(revision, "network");
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  async release(): Promise<void> {
    this.deadline = null;
    this.attemptAt = null;
    const reservation = this.reservation;
    this.reservation = null;
    try {
      await reservation?.release();
    } finally {
      this.releaseWifi?.();
      this.releaseWifi = null;
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.queue;
    await this.release();
    this.options.backend.close();
  }
  private motion(): void {
    if (this.options.motionBlockers().length) {
      throw new NetworkRefusal("Wait until the motorcycle is proven parked before trying Wi-Fi.");
    }
  }
  private check(identity: NetworkRequestIdentity, allowRecovery = false): void {
    const state = this.state();
    if (this.fault && !allowRecovery) {
      throw new NetworkRefusal(this.fault);
    }
    if (
      identity.instanceId !== state.instanceId ||
      identity.generation !== this.generation ||
      identity.revision !== state.revision ||
      identity.settingsRevision !== this.settingsRevision()
    ) {
      throw new NetworkRefusal(
        "This network view is stale. Read this Pi again; cancel and reopen any unsaved editor before saving."
      );
    }
  }
  private serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(work);
    this.queue = result.catch(() =>
      console.warn("wifi-settings: operation refused or failed; no submitted values logged")
    );
    return result;
  }
}

export interface NetworkOptions {
  ledger: NetworkLedgerStore;
  backend: NetworkBackend;
  settings: SettingsStore;
  generation: string;
  motionBlockers: () => string[];
  bluetoothReady: () => boolean;
  hotspotChanged: (ssid: string) => void;
  now?: () => number;
  autoTick?: boolean;
}

export const TRIAL_MS = 120_000;
export const CHECKPOINT_SECONDS = 180;
export const ATTEMPT_MS = 20_000;
export const RETRY_GAP_MS = 10_000;
export const RECOVERY_BUSY = "Wi-Fi recovery is running; try again in a moment";
