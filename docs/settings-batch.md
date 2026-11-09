# Inline Settings

Settings has seven inline sections on one page. Phone display choices, installed hardware, the existing automatic-current permission, the hotspot monitoring name, Bluetooth key and recording public key share one draft and one Save/Cancel row. This changes no server endpoint or stored schema.

Phone theme and units preview through the existing display setters without writing browser storage. Cancel restores both previews and discards every Pi edit. A phone-only Save works without a Pi connection. With shared edits, phone preferences persist after the Pi has confirmed the settings batch.

The Pi receives one existing `PATCH /settings` with the revision captured at the first shared edit. Polling does not advance that revision or erase the draft. A known revision/process change requires Cancel and review; an unseen concurrent change still meets the server's compare-and-swap guard. Rejected, lost, incomplete or inconsistent replies preserve the edits rather than reporting success. A new Pi clears secret drafts. Inputs and Cancel are held while Save is in flight, so a second press cannot send another batch or discard an already submitted choice.

Saved startup choices remain separate from running components. The shared footer shows one restart control when choices await restart or settings need repair. Its existing arm/dwell, generation, motion and Bluetooth-key handover gates remain in place. An update cannot start with unsaved edits. Tab/top-switch navigation asks for Save or Cancel; drafts also survive browser history navigation.

Recording readiness and the active recording/service folders are read-only. Replacing the existing public key remains supported, including the recoverable-private-key confirmation. Bluetooth still requires a recoverable copy before a replacement is saved, retains clipboard/file-export fallback and stores the confirmed pending key for the existing restart/reconnect flow. Stored keys are not read back into the editor. The existing Bluetooth-only connect/import form remains a connection action, separate from saving Pi choices.

The existing automatic-current permission permits Cool Eva to reduce the DC current request when the pack is hot. Temporary pause and the actual outcome stay on Charge.

Wi-Fi provisioning is separate work after the real-network acceptance of #337. This page retains the existing hotspot name used for monitoring; it has no network/password editor. The later integration must preserve the reviewed self-reverting trial and apply Wi-Fi last, after the other choices are saved.

## Layout checks

The page uses shared stacks, rows, typography and 12 px gutters. Dirty fields show their previous choice, while section summaries show current choices rather than generic instructions. Expanded sections hide their summary detail. Each hardware status remains inside its own field; duplicate Off/On readiness is omitted. Help anchors belong to the field rather than a shifting action row, so their full content stays inside a 390 px viewport while editing. The shared footer reserves its measured height above the persistent tabs.

The former geometry readout was diagnostic output rather than a setting and is removed from ordinary Settings. It compared layout viewport/DPR and all four CSS safe-area insets with display-mode, the independent iOS standalone flag, screen size and visual viewport. Its single page-lifetime probe/listener set observed resize, orientation, display-mode and visual-viewport changes. Phone-width and screenshot receipts continue to measure viewport, DPR and safe-area geometry directly.

The former access page and its navigation entry are removed. Its complete wording remains in [Who can control my bike?](wifi-hardening.md#who-can-control-my-bike). The licence link has one home in the Cool Eva software section.

`check-settings-batch.ts` covers the actual client transaction against typed replies. Browser checks exercise both themes, stable switch focus, one request, Cancel, revision conflicts, uncertain outcomes, key privacy, read-only fields and the footer/gutter/help geometry. The existing server and simulator-refusal checks remain authoritative for restart and mutation admission.
