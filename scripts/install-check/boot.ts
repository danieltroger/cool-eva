import { join } from "node:path";
import { startConsole, type GuestConsole } from "./console.ts";

export function bootGuest(executable: string, directory: string, port: number, seed: string | null): GuestConsole {
  const arguments_ = [
    "-M",
    "raspi3ap",
    "-accel",
    "tcg,thread=multi",
    "-kernel",
    join(directory, "boot/kernel8.raw"),
    "-initrd",
    join(directory, "boot/initramfs8"),
    "-dtb",
    join(directory, "boot/qemu.dtb"),
    "-drive",
    `file=${join(directory, "guest.img")},format=raw,if=sd`,
    "-append",
    "console=ttyS0,115200 8250.nr_uarts=1 root=/dev/mmcblk0p2 rootfstype=ext4 rootwait rw loglevel=3 systemd.show_status=no" +
      (seed ? " init=/bin/bash" : ""),
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    "null",
    "-serial",
    "stdio",
    "-device",
    "usb-net,netdev=network",
    "-netdev",
    `user,id=network,hostfwd=tcp:127.0.0.1:${port}-:22`,
  ];
  return startConsole(executable, arguments_, join(directory, seed ? "seed-serial.log" : "boot-serial.log"));
}

export async function seedGuest(console_: GuestConsole, script: string): Promise<void> {
  await console_.wait(/(?:bash-[0-9.]+|root@[^\r\n]+:\/)# /);
  console_.send("stty -echo\n");
  const encoded = Buffer.from(script)
    .toString("base64")
    .match(/.{1,76}/g)!
    .join("\n");
  console_.send(
    `base64 -d > /tmp/cool-eva-qemu-seed <<'SEED_BASE64'\n${encoded}\nSEED_BASE64\n. /tmp/cool-eva-qemu-seed\n`
  );
  await console_.wait(/COOL_EVA_SEED_COMPLETE|Kernel panic/, 300_000);
  if (!console_.output().includes("COOL_EVA_SEED_COMPLETE")) {
    throw new Error("QEMU image seed failed; see its serial log");
  }
}
