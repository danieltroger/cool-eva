# Get help

If the page will not open, check the hotspot steps first. If it opens without bike readings, check the adapter, wake the parked bike, and look at `sudo journalctl -u cool-eva -n 50`. Missing saved history usually means the public key is absent.

[Open a GitHub issue](https://github.com/danieltroger/cool-eva/issues/new) with the bike's model/year, Pi model, OS version, running version shown in the dashboard, and the relevant error text. Remove personal identifiers before posting: ride logs, diagnostic dumps, network names, keys and GPS traces do not belong in a public issue. Useful references: [CAN adapter startup](can-adapter-probe.md), [Wi-Fi](wifi.md), and [Bluetooth connections](connecting-over-bluetooth.md).

## Ask Claude or send feedback

[Download Claude Code](https://code.claude.com/docs/en/quickstart) on your computer, open the Cool Eva project folder and ask Claude to figure out the problem from these instructions and the error. The [computer setup step](manual-install.md#4-enable-saved-ride-history--on-your-computer) explains downloading the project as a ZIP.

Please also [send Daniel feedback through a GitHub issue](https://github.com/danieltroger/cool-eva/issues/new): what was confusing, what went wrong, and how these instructions could improve.
