# Service parameter catalogue

`GET /service-catalogue` supplies the approved Service browser with every parameter identity and group from the active parameter table, and every signal identity, group and unit from the signal registry. It works before the bike has been read. It takes no bus or saved snapshot and returns no readings. Responses are not cached because a completed parameter read can select a different table while the page is open.

The parameter index remains the catalogue identity: four names describe two rows each. Those eight rows and the config word that only supports named bit writes remain read-only in the numeric editor. Numeric bounds come from the existing write target, including its narrower curated policy, or the storage type for a read-only row. The catalogue cannot widen the write codec's policy. The write runner still checks its live gate, table identity, compare-and-swap and readback for every confirmed parameter.

Units are limited to facts already established in the repository: `MAX_DC_CHG_CURRENT` uses amperes; `TORQUE_LIMIT` and `REGEN_TORQUE_LIMIT` use tenths of a newton metre (the existing curated write formatters in `src/vcu/write-targets.ts`); `BEAM_MAX_CURR_TH` uses milliamperes ([the measured light threshold](headlight-beam-threshold.md)). Other values remain raw. In particular, the local manufacturer-definition notes leave map power unresolved; the sketch's synthetic horsepower example is not a scale definition.

The catalogue returns unknown stock as `null`. `params.ecf` carries another bike's values, explicitly recorded as `otherBikeValue` in `src/vcu/param-file.ts`; they cannot fill a field labelled Stock. Current readings come separately from a saved sweep or a parameter read and retain their source identity.
