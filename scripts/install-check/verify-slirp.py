import json
import sys


def main():
    dependencies_file, options_file, expected_version, expected_library = sys.argv[1:]
    with open(dependencies_file) as dependencies_input:
        dependencies = json.load(dependencies_input)
    with open(options_file) as options_input:
        options = json.load(options_input)
    slirp_dependencies = [dependency for dependency in dependencies if dependency.get("name") == "slirp"]
    if len(slirp_dependencies) != 1:
        raise SystemExit("QEMU must resolve exactly one libslirp dependency")
    slirp = slirp_dependencies[0]
    if slirp.get("type") != "pkgconfig" or slirp.get("version") != expected_version:
        raise SystemExit("QEMU libslirp must resolve through pkg-config at the pinned version")
    if expected_library not in slirp.get("link_args", []):
        raise SystemExit("QEMU must link the pinned libslirp archive")
    wrap_modes = [option.get("value") for option in options if option.get("name") == "wrap_mode"]
    if wrap_modes != ["nofallback"]:
        raise SystemExit("QEMU Meson fallbacks must be disabled")
    print(f"QEMU libslirp verified: pkg-config {expected_version}; {expected_library}; wrap_mode=nofallback")


if __name__ == "__main__":
    main()
